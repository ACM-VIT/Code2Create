import type { Doc } from "../_generated/dataModel";

export type EventLifecycleStatus = Doc<"events">["status"];

export type EventLifecycleConfiguration = {
  hasActiveAttendanceSession: boolean;
  hasActiveReviewRound: boolean;
  hasAdmissionPolicy: boolean;
  hasAttendancePlan: boolean;
  hasCommunicationsPolicy: boolean;
  hasEventDates: boolean;
  hasFloorPlan: boolean;
  hasIntegrationPolicy: boolean;
  hasIntakePolicy: boolean;
  hasParticipantPolicy: boolean;
  hasPhaseSchedule: boolean;
  hasProjectCheckpointPlan: boolean;
  hasPublishedReviewRound: boolean;
  hasTrackCatalog: boolean;
};

export type EventLifecycleRequirementKey =
  | "admission_policy"
  | "active_attendance_session"
  | "active_review_round"
  | "attendance_plan"
  | "checkpoint_plan"
  | "communications_policy"
  | "event_dates"
  | "floor_plan"
  | "intake_policy"
  | "integration_policy"
  | "participant_policy"
  | "phase_schedule"
  | "review_round"
  | "track_catalog";

export type EventLifecycleBlocker = {
  key: EventLifecycleRequirementKey;
  label: string;
};

const configurationKeyByRequirement: Readonly<
  Record<EventLifecycleRequirementKey, keyof EventLifecycleConfiguration>
> = {
  admission_policy: "hasAdmissionPolicy",
  active_attendance_session: "hasActiveAttendanceSession",
  active_review_round: "hasActiveReviewRound",
  attendance_plan: "hasAttendancePlan",
  checkpoint_plan: "hasProjectCheckpointPlan",
  communications_policy: "hasCommunicationsPolicy",
  event_dates: "hasEventDates",
  floor_plan: "hasFloorPlan",
  intake_policy: "hasIntakePolicy",
  integration_policy: "hasIntegrationPolicy",
  participant_policy: "hasParticipantPolicy",
  phase_schedule: "hasPhaseSchedule",
  review_round: "hasPublishedReviewRound",
  track_catalog: "hasTrackCatalog",
};

const transitions: Readonly<Record<EventLifecycleStatus, readonly EventLifecycleStatus[]>> = {
  draft: ["registration_open"],
  registration_open: ["registration_closed"],
  registration_closed: ["live", "registration_open"],
  live: ["complete"],
  complete: [],
};

const applicationRequirements: readonly EventLifecycleBlocker[] = [
  { key: "event_dates", label: "Event dates" },
  { key: "participant_policy", label: "Participant form" },
  { key: "track_catalog", label: "Tracks" },
  { key: "intake_policy", label: "Idea questions" },
  { key: "admission_policy", label: "Admissions policy" },
];

const liveRequirements: readonly EventLifecycleBlocker[] = [
  { key: "event_dates", label: "Event dates" },
  { key: "communications_policy", label: "Accepted-team details" },
  { key: "phase_schedule", label: "Event schedule" },
  { key: "checkpoint_plan", label: "Team updates" },
  { key: "attendance_plan", label: "Check-in plan" },
  { key: "floor_plan", label: "Hall layout" },
  { key: "integration_policy", label: "Code and design policy" },
  { key: "review_round", label: "At least one judging round" },
];

const completionBlockers: readonly EventLifecycleBlocker[] = [
  { key: "active_attendance_session", label: "An attendance session is still active" },
  { key: "active_review_round", label: "A judging round is still active" },
];

export function eventLifecycleTargets(status: EventLifecycleStatus) {
  return transitions[status];
}

export function eventLifecycleTransitionAllowed(
  current: EventLifecycleStatus,
  target: EventLifecycleStatus,
) {
  return transitions[current].some((candidate) => candidate === target);
}

export function eventLifecycleBlockers(
  current: EventLifecycleStatus,
  target: EventLifecycleStatus,
  configuration: EventLifecycleConfiguration,
) {
  if (current === "draft" && target === "registration_open") {
    return applicationRequirements.filter(
      (requirement) => !configuration[configurationKeyByRequirement[requirement.key]],
    );
  }
  if (target === "live") {
    return liveRequirements.filter(
      (requirement) => !configuration[configurationKeyByRequirement[requirement.key]],
    );
  }
  if (target === "complete") {
    return completionBlockers.filter(
      (requirement) => configuration[configurationKeyByRequirement[requirement.key]],
    );
  }
  return [];
}
