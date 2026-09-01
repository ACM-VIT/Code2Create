import { describe, expect, test } from "vitest";

import {
  applicationsCloseAtFor,
  requireRegistrationOpen,
} from "./events";

describe("participant-class application deadlines", () => {
  const event = {
    status: "registration_open" as const,
    externalApplicationsCloseAt: 2_000,
    applicationsCloseAt: 3_000,
  };

  test("resolves the published deadline for each participant class", () => {
    expect(applicationsCloseAtFor(event, "external_participant")).toBe(2_000);
    expect(applicationsCloseAtFor(event, "vit_student")).toBe(3_000);
  });

  test("closes external applications without closing VIT applications", () => {
    expect(() =>
      requireRegistrationOpen(event, "external_participant", 2_500),
    ).toThrow("Applications are closed");
    expect(() => requireRegistrationOpen(event, "vit_student", 2_500)).not.toThrow();
  });
});
