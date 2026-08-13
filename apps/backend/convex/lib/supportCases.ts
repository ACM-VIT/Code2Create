import { operationFingerprint } from "./operations";

export const supportCaseStates = [
  "open",
  "investigating",
  "waiting",
  "resolved",
  "closed",
] as const;

export type SupportCaseState = (typeof supportCaseStates)[number];

export type SupportCaseCounters = Record<SupportCaseState, number> & {
  unowned: number;
  awaitingStaffReply: number;
  safety: number;
};

export type SupportCaseCounterSource = {
  state: SupportCaseState;
  category: string;
  ownerPersonId?: string;
  awaitingStaffReply: boolean;
};

export const supportCaseCounterShardCount = 16;

export function supportCaseCounterShardFor(supportCaseId: string) {
  return (
    Number.parseInt(operationFingerprint([supportCaseId]).slice(0, 8), 16) %
    supportCaseCounterShardCount
  );
}

const counterKeys = [
  ...supportCaseStates,
  "unowned",
  "awaitingStaffReply",
  "safety",
] as const;

export function emptySupportCaseCounters(): SupportCaseCounters {
  return {
    open: 0,
    investigating: 0,
    waiting: 0,
    resolved: 0,
    closed: 0,
    unowned: 0,
    awaitingStaffReply: 0,
    safety: 0,
  };
}

export function applySupportCaseCounterChange(
  current: SupportCaseCounters,
  before: SupportCaseCounterSource | undefined,
  after: SupportCaseCounterSource | undefined,
) {
  const next = { ...current };
  if (before !== undefined) addContribution(next, before, -1);
  if (after !== undefined) addContribution(next, after, 1);
  for (const key of counterKeys) {
    if (!Number.isSafeInteger(next[key]) || next[key] < 0) {
      throw new Error(`Support counter ${key} would become invalid.`);
    }
  }
  return next;
}

function addContribution(
  counters: SupportCaseCounters,
  supportCase: SupportCaseCounterSource,
  direction: 1 | -1,
) {
  counters[supportCase.state] += direction;
  if (!isActiveSupportCaseState(supportCase.state)) return;
  if (supportCase.ownerPersonId === undefined) counters.unowned += direction;
  if (supportCase.awaitingStaffReply) counters.awaitingStaffReply += direction;
  if (supportCase.category === "safety") counters.safety += direction;
}

export function isActiveSupportCaseState(state: SupportCaseState) {
  return state === "open" || state === "investigating" || state === "waiting";
}

const allowedTransitions = {
  open: ["investigating", "waiting", "resolved", "closed"],
  investigating: ["open", "waiting", "resolved", "closed"],
  waiting: ["open", "investigating", "resolved", "closed"],
  resolved: ["open", "investigating", "closed"],
  closed: ["open"],
} as const satisfies Record<SupportCaseState, readonly SupportCaseState[]>;

export function canTransitionSupportCase(
  current: SupportCaseState,
  next: SupportCaseState,
) {
  return allowedTransitions[current].some((candidate) => candidate === next);
}
