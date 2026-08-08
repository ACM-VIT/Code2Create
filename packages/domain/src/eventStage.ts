/**
 * What running the event looks like from the operator's side.
 *
 * The event already moves through five states, but nothing used them to shape
 * what an operator is shown, so every destination and every setting was on
 * screen at once with nothing to say which mattered today. That is the whole
 * reason the dashboard is hard to read: it has no sense of sequence.
 *
 * This module is the sequence. It answers three questions for any state — what
 * stage are we in, what is this stage for, and which parts of the product does
 * it actually use — so the shell can lead with those and put the rest away.
 */

export type EventStage =
  | "draft"
  | "registration_open"
  | "registration_closed"
  | "live"
  | "complete";

export type EventStageGuidance = {
  /** What to call this stage in the interface. */
  label: string;
  /** What the operator is trying to achieve before moving on. */
  goal: string;
  /** What moving on is called, phrased as the operator would say it. */
  nextStep: string | null;
  /** The state that step moves to, so its blockers can be looked up. */
  nextStatus: EventStage | null;
  /** Routes this stage actually uses, most important first. */
  primaryPaths: readonly string[];
};

export const eventStageGuidance: Record<EventStage, EventStageGuidance> = {
  draft: {
    label: "Setting up",
    goal: "Decide how teams apply, then open applications.",
    nextStep: "Open applications",
    nextStatus: "registration_open",
    primaryPaths: ["/configuration", "/access", "/rehearsal"],
  },
  registration_open: {
    label: "Applications open",
    goal: "Teams are applying. Review them as they arrive and answer questions.",
    nextStep: "Close applications",
    nextStatus: "registration_closed",
    primaryPaths: ["/admissions", "/support", "/configuration"],
  },
  registration_closed: {
    label: "Applications closed",
    goal: "Finish decisions and offers, then get the venue ready for the event.",
    nextStep: "Start the event",
    nextStatus: "live",
    primaryPaths: ["/admissions", "/configuration", "/rehearsal"],
  },
  live: {
    label: "Event running",
    goal: "Keep people checked in, teams routed, and reviews moving.",
    nextStep: "Finish the event",
    nextStatus: "complete",
    primaryPaths: ["/", "/attendance", "/floor", "/reviews", "/support"],
  },
  complete: {
    label: "Event finished",
    goal: "Verify and close each round, then publish results.",
    nextStep: null,
    nextStatus: null,
    primaryPaths: ["/scores", "/"],
  },
};

/**
 * Where each lifecycle blocker is fixed.
 *
 * The backend already names what is missing before a transition; without a
 * route the operator is told they are blocked and left to find the screen.
 */
export const eventBlockerPaths: Record<string, string> = {
  event_dates: "/configuration",
  participant_policy: "/configuration/participants",
  track_catalog: "/configuration/tracks",
  intake_policy: "/configuration/intake",
  admission_policy: "/configuration/admissions",
  communications_policy: "/configuration/communications",
  phase_schedule: "/configuration/phases",
  checkpoint_plan: "/configuration/checkpoints",
  attendance_plan: "/attendance-setup",
  floor_plan: "/floor-setup",
  review_round: "/review-setup",
};

/** Blockers that stop the event *finishing* read as work in progress, not setup. */
export const activeWorkBlockerKeys: readonly string[] = [
  "active_attendance_session",
  "active_review_round",
];
