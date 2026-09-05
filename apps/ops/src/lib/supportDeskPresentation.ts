import type { api } from "@code2create/backend/api";
import { supportCaseStateLabels, type SupportCaseState } from "@code2create/domain";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

type StaffList = FunctionReturnType<typeof api.support.staffList>;
export type SupportCase = StaffList["cases"][number];
export type SupportTotals = StaffList["totals"];
export type SupportFilter = FunctionArgs<typeof api.support.staffList>["state"];
export type SupportCaseDetail = NonNullable<FunctionReturnType<typeof api.support.detail>>;
export type SupportAction = SupportCaseDetail["actions"][number];

type QueueCase = Pick<
  SupportCase,
  "state" | "category" | "awaitingStaffReply" | "ownerName" | "lastActionAt"
>;
type RowCase = Pick<
  SupportCase,
  "state" | "awaitingStaffReply" | "firstResponseAt" | "createdAt" | "lastActionAt" | "ownerName"
>;

export const supportFilters = [
  ["active", "Still open"],
  ["resolved", "Resolved"],
  ["closed", "Closed"],
  ["all", "Everything"],
] as const satisfies readonly (readonly [SupportFilter, string])[];

/** A request owed a reply counts as stale once the desk has been silent this long. */
export const supportStaleAfterMs = 60 * 60 * 1000;

const guideHandoffPrefix = "Guide handoff:";
const guideActorName = "Code2Create Guide";
const guideNotePrefixes = [
  ["Code2Create Guide handoff", "handoff"],
  ["Code2Create Guide reply", "reply"],
] as const;

const stateTransitions = {
  open: ["investigating", "waiting", "resolved", "closed"],
  investigating: ["open", "waiting", "resolved", "closed"],
  waiting: ["open", "investigating", "resolved", "closed"],
  resolved: ["open", "investigating", "closed"],
  closed: ["open"],
} as const satisfies Record<SupportCaseState, readonly SupportCaseState[]>;

export type SupportQueueGroup = "safety" | "reply" | "working" | "reporter" | "resolved" | "closed";

const queueGroupOrder: readonly SupportQueueGroup[] = [
  "safety",
  "reply",
  "working",
  "reporter",
  "resolved",
  "closed",
];

export const supportQueueGroupLabels: Record<SupportQueueGroup, string> = {
  safety: "Safety first",
  reply: "Owed a reply",
  working: "Replied, still open",
  reporter: "With the reporter",
  resolved: "Resolved",
  closed: "Closed",
};

export type SupportRowTone = "critical" | "attention" | "watch" | "quiet";
export type SupportMessageRole = "reporter" | "staff" | "internal" | "guide" | "system";
export type SupportComposerMode = "reply" | "note";

export function isLiveSupportState(state: SupportCaseState) {
  return state === "open" || state === "investigating" || state === "waiting";
}

export function supportLiveCount(totals: SupportTotals) {
  return totals.open + totals.investigating + totals.waiting;
}

export function supportEveryCount(totals: SupportTotals) {
  return supportLiveCount(totals) + totals.resolved + totals.closed;
}

export function supportFilterCount(filter: SupportFilter, totals: SupportTotals) {
  if (filter === "active") return supportLiveCount(totals);
  if (filter === "resolved") return totals.resolved;
  if (filter === "closed") return totals.closed;
  return supportEveryCount(totals);
}

export function supportLeadSentence(filter: SupportFilter, totals: SupportTotals): string {
  if (filter === "resolved") {
    if (totals.resolved === 0) return "Nothing has been resolved yet.";
    return `${totals.resolved} ${totals.resolved === 1 ? "request is" : "requests are"} resolved and can be closed.`;
  }
  if (filter === "closed") {
    if (totals.closed === 0) return "Nothing has been closed yet.";
    return `${totals.closed} ${totals.closed === 1 ? "request is" : "requests are"} closed. Nothing here needs action.`;
  }
  const live = supportLiveCount(totals);
  if (live === 0) return "Nothing is open. Nobody is waiting on the desk.";

  const sentences: string[] = [];
  if (totals.safety > 0) {
    sentences.push(
      `${totals.safety} safety ${totals.safety === 1 ? "report needs" : "reports need"} someone first.`,
    );
  }
  if (totals.awaitingStaffReply > 0) {
    sentences.push(
      `${totals.awaitingStaffReply} ${totals.awaitingStaffReply === 1 ? "request is" : "requests are"} waiting on a reply from the desk.`,
    );
  } else {
    sentences.push("Every open request has had a reply.");
  }
  if (totals.unowned > 0) {
    sentences.push(`${totals.unowned} ${totals.unowned === 1 ? "has" : "have"} nobody assigned.`);
  } else if (totals.waiting > 0) {
    sentences.push(
      `${totals.waiting} ${totals.waiting === 1 ? "is" : "are"} back with the reporter.`,
    );
  }
  return sentences.slice(0, 2).join(" ");
}

export function supportEmptyQueueText(filter: SupportFilter): string {
  if (filter === "resolved") return "Nothing has been resolved yet.";
  if (filter === "closed") return "Nothing has been closed yet.";
  if (filter === "all") return "Nobody has asked the desk for anything yet.";
  return "No open requests.";
}

export function supportQueueGroup(
  supportCase: Pick<QueueCase, "state" | "category" | "awaitingStaffReply">,
): SupportQueueGroup {
  if (supportCase.state === "closed") return "closed";
  if (supportCase.state === "resolved") return "resolved";
  if (supportCase.category === "safety") return "safety";
  if (supportCase.awaitingStaffReply) return "reply";
  if (supportCase.state === "waiting") return "reporter";
  return "working";
}

/** Safety first, then whoever is owed a reply (nobody assigned before somebody), oldest silence first. */
export function compareSupportCases(left: QueueCase, right: QueueCase): number {
  const leftGroup = supportQueueGroup(left);
  const rightGroup = supportQueueGroup(right);
  const byGroup = queueGroupOrder.indexOf(leftGroup) - queueGroupOrder.indexOf(rightGroup);
  if (byGroup !== 0) return byGroup;
  if (leftGroup === "reply") {
    const byOwner = Number(left.ownerName !== undefined) - Number(right.ownerName !== undefined);
    if (byOwner !== 0) return byOwner;
  }
  const finished = leftGroup === "resolved" || leftGroup === "closed";
  return finished ? right.lastActionAt - left.lastActionAt : left.lastActionAt - right.lastActionAt;
}

export function groupSupportCases<Case extends QueueCase>(
  cases: readonly Case[],
): { group: SupportQueueGroup; label: string; cases: Case[] }[] {
  const groups: { group: SupportQueueGroup; label: string; cases: Case[] }[] = [];
  for (const supportCase of [...cases].sort(compareSupportCases)) {
    const group = supportQueueGroup(supportCase);
    const last = groups.at(-1);
    if (last !== undefined && last.group === group) {
      last.cases.push(supportCase);
    } else {
      groups.push({ group, label: supportQueueGroupLabels[group], cases: [supportCase] });
    }
  }
  return groups;
}

export function supportRowTone(supportCase: QueueCase, now: number): SupportRowTone {
  const group = supportQueueGroup(supportCase);
  if (group === "resolved" || group === "closed") return "quiet";
  if (group === "safety") return "critical";
  if (group === "reply") {
    return now - supportCase.lastActionAt > supportStaleAfterMs ? "critical" : "attention";
  }
  return "watch";
}

/** One short clause: what the desk is waiting for, and for how long. */
export function supportRowStatus(supportCase: RowCase, now: number): string {
  if (supportCase.state === "resolved")
    return `Resolved ${formatSupportAge(supportCase.lastActionAt, now)}`;
  if (supportCase.state === "closed")
    return `Closed ${formatSupportAge(supportCase.lastActionAt, now)}`;
  if (supportCase.awaitingStaffReply) {
    return supportCase.firstResponseAt === undefined
      ? `No reply yet · reported ${formatSupportAge(supportCase.createdAt, now)}`
      : `Wrote back ${formatSupportAge(supportCase.lastActionAt, now)}`;
  }
  if (supportCase.state === "waiting") {
    return `With the reporter · ${formatSupportAge(supportCase.lastActionAt, now)}`;
  }
  return `${supportCaseStateLabels[supportCase.state]} · replied ${formatSupportAge(supportCase.lastActionAt, now)}`;
}

export function supportRowOwner(
  supportCase: Pick<RowCase, "state" | "ownerName">,
): { label: string; missing: boolean } | null {
  if (!isLiveSupportState(supportCase.state)) return null;
  return supportCase.ownerName === undefined
    ? { label: "Nobody assigned", missing: true }
    : { label: supportCase.ownerName, missing: false };
}

/** The first line of the description, without the Guide's routing prefix. */
export function supportExcerpt(
  description: string,
  limit = 120,
): { text: string; viaGuide: boolean } {
  const viaGuide = description.startsWith(guideHandoffPrefix);
  const text = (viaGuide ? description.slice(guideHandoffPrefix.length) : description)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return { text, viaGuide };
  const cut = text.slice(0, limit + 1);
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut.slice(0, limit);
  return { text: `${kept.trimEnd()}…`, viaGuide };
}

export function supportStatusChoices(current: SupportCaseState): SupportCaseState[] {
  return [current, ...stateTransitions[current]];
}

export function supportCaseRefreshPending(
  observedVersion: number,
  committedVersion: number | null,
): boolean {
  return committedVersion !== null && observedVersion < committedVersion;
}

export function parseSupportFilter(value: string): SupportFilter {
  return supportFilters.find(([filter]) => filter === value)?.[0] ?? "active";
}

export function supportMessageRole(
  action: Pick<SupportAction, "kind" | "actorName">,
): SupportMessageRole {
  if (action.kind === "opened" || action.kind === "reporter_reply") return "reporter";
  if (action.kind === "public_note") return "staff";
  if (action.kind === "internal_note")
    return action.actorName === guideActorName ? "guide" : "internal";
  return "system";
}

/** Guide notes carry their own heading line; the thread already names the Guide, so drop it. */
export function supportGuideNote(body: string): { kind: "handoff" | "reply"; text: string } | null {
  for (const [prefix, kind] of guideNotePrefixes) {
    if (body.startsWith(prefix)) return { kind, text: body.slice(prefix.length).trim() };
  }
  return null;
}

export function supportMessageTag(
  action: Pick<SupportAction, "kind" | "actorName" | "body">,
): string {
  if (action.kind === "opened") return "opened the request";
  if (action.kind === "reporter_reply") return "wrote back";
  if (action.kind === "public_note") return "replied to the reporter";
  if (action.kind === "internal_note") {
    const guide =
      action.actorName === guideActorName && action.body !== undefined
        ? supportGuideNote(action.body)
        : null;
    if (guide?.kind === "handoff") return "handed this to the desk";
    if (guide?.kind === "reply") return "answered the participant";
    return "desk note";
  }
  return "";
}

export function supportEventText(
  action: Pick<
    SupportAction,
    "kind" | "actorName" | "previousState" | "nextState" | "previousOwnerName" | "nextOwnerName"
  >,
): string {
  if (action.kind === "state_changed") {
    const from = supportCaseStateLabels[action.previousState ?? "open"];
    const to = supportCaseStateLabels[action.nextState ?? "open"];
    return `${action.actorName} moved it from ${from} to ${to}`;
  }
  if (action.kind === "owner_changed") {
    const previous = action.previousOwnerName;
    const next = action.nextOwnerName;
    if (next !== undefined && previous === undefined) {
      return next === action.actorName
        ? `${next} took it`
        : `${action.actorName} handed it to ${next}`;
    }
    if (next === undefined && previous !== undefined) {
      return previous === action.actorName
        ? `${previous} handed it back to the queue`
        : `${action.actorName} took it from ${previous} and put it back in the queue`;
    }
    if (next !== undefined && previous !== undefined) {
      if (next === action.actorName) return `${next} took it from ${previous}`;
      if (previous === action.actorName) return `${previous} handed it to ${next}`;
      return `${action.actorName} handed it from ${previous} to ${next}`;
    }
  }
  return `${action.actorName} updated the request`;
}

export function supportUpdateReason(update: {
  publicNote: boolean;
  internalNote: boolean;
  nextState: SupportCaseState | null;
}): string {
  const parts: string[] = [];
  if (update.publicNote) parts.push("replied to the reporter");
  if (update.internalNote) parts.push("added a desk note");
  if (update.nextState !== null) {
    parts.push(`moved it to ${supportCaseStateLabels[update.nextState].toLowerCase()}`);
  }
  return `Help desk ${joinClauses(parts)}`;
}

export function supportOwnerReason(
  change: { kind: "claim" } | { kind: "release" } | { kind: "handoff"; displayName: string },
): string {
  if (change.kind === "claim") return "Claimed at the help desk";
  if (change.kind === "release") return "Returned to the unassigned support queue";
  return `Handed to ${change.displayName} at the help desk`;
}

export function supportFirstReply(createdAt: number, firstResponseAt: number | undefined): string {
  if (firstResponseAt === undefined) return "No reply from the desk yet";
  return `First reply ${formatSupportDuration(firstResponseAt - createdAt)} after it was reported`;
}

export function formatSupportDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function formatSupportAge(value: number, now: number) {
  const minutes = Math.max(0, Math.round((now - value) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}
