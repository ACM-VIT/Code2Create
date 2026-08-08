export const supportCaseStates = [
  "open",
  "investigating",
  "waiting",
  "resolved",
  "closed",
] as const;

export type SupportCaseState = (typeof supportCaseStates)[number];

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
