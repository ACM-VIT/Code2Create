import { describe, expect, test } from "vitest";

import {
  maximumAttendanceSessionsPerPlan,
  maximumAttendanceStationsPerPlan,
  maximumAttendanceZonesPerPlan,
  requireAttendancePlanLimits,
} from "./attendancePlanLimits";

const optionalSession = {
  requirement: "optional" as const,
  expectedCohort: { kind: "all_admitted" as const },
  startsAt: 1_000,
  endsAt: 2_000,
};

describe("attendance plan limits", () => {
  test("accepts each owner collection at its published maximum", () => {
    expect(() => requireAttendancePlanLimits({
      zones: Array.from({ length: maximumAttendanceZonesPerPlan }, () => ({})),
      sessions: Array.from(
        { length: maximumAttendanceSessionsPerPlan },
        (_, index) => ({ ...optionalSession, startsAt: index * 2_000, endsAt: index * 2_000 + 1_000 }),
      ),
      stations: Array.from({ length: maximumAttendanceStationsPerPlan }, () => ({})),
    })).not.toThrow();
  });

  test.each([
    ["areas", maximumAttendanceZonesPerPlan + 1, 1, 1],
    ["sessions", 1, maximumAttendanceSessionsPerPlan + 1, 1],
    ["scanner stations", 1, 1, maximumAttendanceStationsPerPlan + 1],
  ])("rejects too many %s", (label, zoneCount, sessionCount, stationCount) => {
    expect(() => requireAttendancePlanLimits({
      zones: Array.from({ length: zoneCount }, () => ({})),
      sessions: Array.from(
        { length: sessionCount },
        (_, index) => ({ ...optionalSession, startsAt: index * 2_000, endsAt: index * 2_000 + 1_000 }),
      ),
      stations: Array.from({ length: stationCount }, () => ({})),
    })).toThrow(`at most ${label === "areas" ? maximumAttendanceZonesPerPlan : label === "sessions" ? maximumAttendanceSessionsPerPlan : maximumAttendanceStationsPerPlan}`);
  });

  test("allows disjoint cohorts but rejects a fifth possibly applicable overlap", () => {
    const fourCompatible = [
      optionalSession,
      { ...optionalSession, expectedCohort: { kind: "participant_classes" as const, participantClasses: ["vit_student" as const] } },
      { ...optionalSession, expectedCohort: { kind: "tracks" as const, trackVersionIds: ["track-a"] } },
      { ...optionalSession, expectedCohort: { kind: "explicit" as const, membershipIds: ["member-a"] } },
    ];
    const disjointClass = {
      ...optionalSession,
      expectedCohort: {
        kind: "participant_classes" as const,
        participantClasses: ["external_participant" as const],
      },
    };
    expect(() => requireAttendancePlanLimits({
      zones: [{}],
      sessions: [...fourCompatible.slice(0, 2), disjointClass],
      stations: [{}],
    })).not.toThrow();
    expect(() => requireAttendancePlanLimits({
      zones: [{}],
      sessions: [...fourCompatible, optionalSession],
      stations: [{}],
    })).toThrow("more than 4 attendance sessions");
  });

  test("rejects overlapping required sessions for a possible participant", () => {
    expect(() => requireAttendancePlanLimits({
      zones: [{}],
      sessions: [
        { ...optionalSession, requirement: "required" },
        {
          ...optionalSession,
          requirement: "required",
          expectedCohort: {
            kind: "participant_classes",
            participantClasses: ["vit_student"],
          },
        },
      ],
      stations: [{}],
    })).toThrow("required in two attendance sessions");
  });
});
