import { ConvexError } from "convex/values";

export const maximumAttendanceZonesPerPlan = 32;
export const maximumAttendanceSessionsPerPlan = 64;
export const maximumAttendanceStationsPerPlan = 128;
export const maximumSimultaneousAttendanceSessionsPerParticipant = 4;
export const maximumAttendanceParticipantsPerSession = 1_200;

type ParticipantClass = "vit_student" | "external_participant";

type AttendanceCohort =
  | { kind: "all_admitted" }
  | { kind: "participant_classes"; participantClasses: readonly ParticipantClass[] }
  | { kind: "explicit"; membershipIds: readonly string[] };

type AttendanceSessionLimitInput = {
  requirement: "required" | "optional" | "information_only";
  expectedCohort: AttendanceCohort;
  startsAt: number;
  endsAt: number;
};

export function requireAttendancePlanLimits(args: {
  zones: readonly object[];
  sessions: readonly AttendanceSessionLimitInput[];
  stations: readonly object[];
}) {
  requireCollectionLimit(
    args.zones.length,
    maximumAttendanceZonesPerPlan,
    "ATTENDANCE_ZONE_LIMIT_REACHED",
    "areas",
  );
  requireCollectionLimit(
    args.sessions.length,
    maximumAttendanceSessionsPerPlan,
    "ATTENDANCE_SESSION_LIMIT_REACHED",
    "sessions",
  );
  requireCollectionLimit(
    args.stations.length,
    maximumAttendanceStationsPerPlan,
    "ATTENDANCE_STATION_LIMIT_REACHED",
    "scanner stations",
  );

  for (const session of args.sessions) {
    if (
      !Number.isFinite(session.startsAt) ||
      !Number.isFinite(session.endsAt) ||
      session.startsAt >= session.endsAt
    ) {
      throw new ConvexError({
        code: "INVALID_SESSION_TIME",
        message: "Every attendance session must have a finite start before its end.",
      });
    }
  }

  const boundaries = [...new Set(
    args.sessions.flatMap((session) => [session.startsAt, session.endsAt]),
  )].sort((left, right) => left - right);
  for (const boundary of boundaries) {
    const active = args.sessions.filter(
      (session) => session.startsAt <= boundary && boundary < session.endsAt,
    );
    const applicableCount = maximumPossibleApplicableSessionCount(active);
    if (applicableCount > maximumSimultaneousAttendanceSessionsPerParticipant) {
      throw new ConvexError({
        code: "ATTENDANCE_SESSION_CONCURRENCY_LIMIT_REACHED",
        message: `No participant can have more than ${maximumSimultaneousAttendanceSessionsPerParticipant} attendance sessions at the same time.`,
      });
    }
    const requiredCount = maximumPossibleApplicableSessionCount(
      active.filter((session) => session.requirement === "required"),
    );
    if (requiredCount > 1) {
      throw new ConvexError({
        code: "CONTRADICTORY_REQUIRED_ATTENDANCE",
        message: "A participant cannot be required in two attendance sessions at the same time.",
      });
    }
  }
}

function requireCollectionLimit(
  actual: number,
  maximum: number,
  code: string,
  label: string,
) {
  if (actual > maximum) {
    throw new ConvexError({
      code,
      message: `An attendance plan can contain at most ${maximum} ${label}.`,
    });
  }
}

function maximumPossibleApplicableSessionCount(
  sessions: readonly AttendanceSessionLimitInput[],
) {
  let universalCount = 0;
  const classCounts = new Map<ParticipantClass, number>();
  const membershipCounts = new Map<string, number>();

  for (const session of sessions) {
    const cohort = session.expectedCohort;
    if (cohort.kind === "all_admitted") {
      universalCount += 1;
    } else if (cohort.kind === "participant_classes") {
      incrementEach(classCounts, cohort.participantClasses);
    } else {
      incrementEach(membershipCounts, cohort.membershipIds);
    }
  }

  return universalCount +
    maximumCount(classCounts) +
    maximumCount(membershipCounts);
}

function incrementEach<Key>(counts: Map<Key, number>, values: readonly Key[]) {
  for (const value of new Set(values)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
}

function maximumCount<Key>(counts: Map<Key, number>) {
  let maximum = 0;
  for (const count of counts.values()) maximum = Math.max(maximum, count);
  return maximum;
}
