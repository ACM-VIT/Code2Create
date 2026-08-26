export type EventStage =
  | "draft"
  | "registration_open"
  | "registration_closed"
  | "live"
  | "complete";

export type EventStageGuidance = {
  label: string;
  goal: string;
  nextStep: string | null;
  nextStatus: EventStage | null;
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

/** Maps lifecycle blockers to the screen where they can be resolved. */
export const eventBlockerPaths: Record<string, string> = {
  active_attendance_session: "/attendance",
  active_review_round: "/reviews",
  event_dates: "/configuration",
  future_application_deadline: "/configuration",
  participant_policy: "/configuration/participants",
  intake_policy: "/configuration/intake",
  admission_policy: "/configuration/admissions",
  communications_policy: "/configuration/communications",
  integration_policy: "/configuration/integrations",
  phase_schedule: "/configuration/phases",
  checkpoint_plan: "/configuration/checkpoints",
  attendance_plan: "/attendance-setup",
  floor_plan: "/floor-setup",
  review_round: "/review-setup",
};

export const activeWorkBlockerKeys: readonly string[] = [
  "active_attendance_session",
  "active_review_round",
];
