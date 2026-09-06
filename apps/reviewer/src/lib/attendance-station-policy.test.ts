import { describe, expect, test } from "vitest";

import { allowedRovingTransitions, stationAcceptsCredential, physicalCardKind } from "./attendance-station-policy";

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
    expect(stationAcceptsCredential(allowed, "external_pass")).toBe(false);
  });
});

test("recognizes the printed graVITas external registration barcode", () => {
  expect(physicalCardKind("GR2026001861")).toBe("external_id_barcode");
  expect(physicalCardKind("  gr2026001861\n")).toBe("external_id_barcode");
  expect(physicalCardKind("25BCE2164")).toBe("vit_id_barcode");
  expect(stationAcceptsCredential(["external_pass"], "external_id_barcode")).toBe(true);
  expect(stationAcceptsCredential(["vit_id_barcode"], "external_id_barcode")).toBe(false);
});
