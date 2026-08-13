import { describe, expect, test } from "vitest";

import type { Id } from "../_generated/dataModel";
import { normalizeAdmissionTrackCapacities } from "./admissionCapacityPolicy";

function track(id: string) {
  return id as Id<"trackVersions">;
}

describe("admission track capacity policy", () => {
  test("normalizes distinct optional track quotas into stable order", () => {
    expect(normalizeAdmissionTrackCapacities([
      { trackVersionId: track("track-b"), participantCapacity: 40 },
      { trackVersionId: track("track-a"), participantCapacity: 20 },
    ], 100)).toEqual([
      { trackVersionId: "track-a", participantCapacity: 20 },
      { trackVersionId: "track-b", participantCapacity: 40 },
    ]);
    expect(normalizeAdmissionTrackCapacities([], 100)).toEqual([]);
  });

  test("rejects duplicate, fractional, and impossible quotas", () => {
    expect(() => normalizeAdmissionTrackCapacities([
      { trackVersionId: track("track-a"), participantCapacity: 20 },
      { trackVersionId: track("track-a"), participantCapacity: 30 },
    ], 100)).toThrow("at most one");
    expect(() => normalizeAdmissionTrackCapacities([
      { trackVersionId: track("track-a"), participantCapacity: 1.5 },
    ], 100)).toThrow("positive whole number");
    expect(() => normalizeAdmissionTrackCapacities([
      { trackVersionId: track("track-a"), participantCapacity: 101 },
    ], 100)).toThrow("no larger than overall capacity");
  });
});
