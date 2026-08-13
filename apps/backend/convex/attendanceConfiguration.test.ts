import { describe, expect, test } from "vitest";

import { validateAttendanceStationBinding } from "./attendanceConfiguration";
import { hasConfiguredAttendanceStationPolicy } from "./lib/attendance";

const sessions = [
  { stableKey: "main_session", zoneKey: "main" },
  { stableKey: "annex_session", zoneKey: "annex" },
] as const;

describe("attendance station configuration", () => {
  test("historical stations stay unusable until both policy fields are explicit", () => {
    expect(hasConfiguredAttendanceStationPolicy({})).toBe(false);
    expect(hasConfiguredAttendanceStationPolicy({ mode: "venue_entry" })).toBe(false);
    expect(
      hasConfiguredAttendanceStationPolicy({
        mode: "venue_entry",
        allowedCredentialKinds: [],
      }),
    ).toBe(false);
    expect(
      hasConfiguredAttendanceStationPolicy({
        mode: "venue_entry",
        allowedCredentialKinds: ["vit_id_barcode"],
      }),
    ).toBe(true);
  });

  test.each(["session_confirm", "zone_entry", "zone_exit"] as const)(
    "%s requires a bound session",
    (mode) => {
      expect(() =>
        validateAttendanceStationBinding({ mode, stationZoneKey: "main", sessions }),
      ).toThrow("must select a session");
    },
  );

  test.each(["venue_entry", "venue_exit"] as const)(
    "%s rejects a bound session",
    (mode) => {
      expect(() =>
        validateAttendanceStationBinding({
          mode,
          stationZoneKey: "main",
          sessionKey: "main_session",
          sessions,
        }),
      ).toThrow("cannot select a session");
    },
  );

  test("a bound session must exist in the station zone", () => {
    expect(() =>
      validateAttendanceStationBinding({
        mode: "session_confirm",
        stationZoneKey: "main",
        sessionKey: "missing",
        sessions,
      }),
    ).toThrow("unknown session");
    expect(() =>
      validateAttendanceStationBinding({
        mode: "session_confirm",
        stationZoneKey: "main",
        sessionKey: "annex_session",
        sessions,
      }),
    ).toThrow("station's zone");
  });

  test("roving may be venue-wide or session-bound", () => {
    expect(() =>
      validateAttendanceStationBinding({ mode: "roving", stationZoneKey: "main", sessions }),
    ).not.toThrow();
    expect(() =>
      validateAttendanceStationBinding({
        mode: "roving",
        stationZoneKey: "main",
        sessionKey: "main_session",
        sessions,
      }),
    ).not.toThrow();
  });
});
