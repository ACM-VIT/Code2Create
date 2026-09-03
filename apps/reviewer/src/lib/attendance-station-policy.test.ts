import { describe, expect, test } from "vitest";

import { allowedRovingTransitions, stationAcceptsCredential } from "./attendance-station-policy";

describe("attendance station policy", () => {
  test("does not offer a direction picker at fixed stations", () => {
    expect(allowedRovingTransitions({ mode: "venue_entry" })).toEqual([]);
    expect(allowedRovingTransitions({ mode: "session_confirm", sessionId: "session-1" })).toEqual(
      [],
    );
  });

  test("offers session and zone movements only to an open session-bound roving station", () => {
    expect(allowedRovingTransitions({ mode: "roving" })).toEqual(["venue_entry", "venue_exit"]);
    expect(allowedRovingTransitions({ mode: "roving", sessionId: "session-1" })).toEqual([
      "venue_entry",
      "venue_exit",
    ]);
    expect(
      allowedRovingTransitions({
        mode: "roving",
        sessionId: "session-1",
        openSessionId: "session-1",
      }),
    ).toEqual(["venue_entry", "venue_exit", "session_confirm", "zone_entry", "zone_exit"]);
  });

  test("refuses credential kinds outside the published assignment", () => {
    const allowed = ["badge_qr", "vit_id_barcode"] as const;
    expect(stationAcceptsCredential(allowed, "badge_qr")).toBe(true);
    expect(stationAcceptsCredential(allowed, "portal_qr")).toBe(false);
  });
});
