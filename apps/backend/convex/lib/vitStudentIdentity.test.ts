import { describe, expect, test } from "vitest";

import {
  isApprovedVitStudentIdentity,
  parseVitRegistrationNumber,
  parseVitStudentGoogleDisplayName,
  vitInstitutionName,
} from "./vitStudentIdentity.ts";

const eventYear = 2026;

describe("VIT student identity", () => {
  test("requires both the exact verified email domain and Google Workspace domain", () => {
    expect(isApprovedVitStudentIdentity({
      verifiedEmail: "student@vitstudent.ac.in",
      hostedDomain: "vitstudent.ac.in",
      allowedDomains: ["vitstudent.ac.in"],
    })).toBe(true);
    expect(isApprovedVitStudentIdentity({
      verifiedEmail: "student@example.com",
      hostedDomain: "vitstudent.ac.in",
      allowedDomains: ["vitstudent.ac.in"],
    })).toBe(false);
    expect(isApprovedVitStudentIdentity({
      verifiedEmail: "student@vitstudent.ac.in",
      hostedDomain: "example.com",
      allowedDomains: ["vitstudent.ac.in"],
    })).toBe(false);
    expect(isApprovedVitStudentIdentity({
      verifiedEmail: "student@alumni.vitstudent.ac.in",
      hostedDomain: "vitstudent.ac.in",
      allowedDomains: ["vitstudent.ac.in"],
    })).toBe(false);
  });

  test("uses the canonical institution name for internal profiles", () => {
    expect(vitInstitutionName).toBe("Vellore Institute of Technology");
  });

  test.each([
    ["Asha Rao 26BCE1234", "first"],
    ["Asha Rao 25MCA1234", "second"],
    ["Asha Rao 24MIM1234", "third"],
    ["Asha Rao 23BDS1234", "fourth"],
    ["Asha Rao 22MIS1234", "fifth_or_later"],
    ["Asha Rao 20PHD1234", "fifth_or_later"],
  ] as const)("derives %s from the configured event year", (displayName, yearOfStudy) => {
    expect(parseVitStudentGoogleDisplayName(displayName, eventYear)).toMatchObject({
      fullName: "Asha Rao",
      registrationNumber: displayName.split(" ").at(-1),
      yearOfStudy,
    });
  });

  test("rejects future cohorts and malformed Google names", () => {
    expect(parseVitStudentGoogleDisplayName("Asha Rao 27BCE1234", eventYear)).toBeNull();
    expect(parseVitStudentGoogleDisplayName("Asha Rao BCE1234", eventYear)).toBeNull();
    expect(parseVitStudentGoogleDisplayName("26BCE1234", eventYear)).toBeNull();
  });

  test("normalizes a standalone VIT registration number", () => {
    expect(parseVitRegistrationNumber("24bci0150", eventYear)).toEqual({
      registrationNumber: "24BCI0150",
      programmeCode: "BCI",
      yearOfStudy: "third",
    });
    expect(parseVitRegistrationNumber("27BCI0150", eventYear)).toBeNull();
    expect(parseVitRegistrationNumber("BCI0150", eventYear)).toBeNull();
  });
});
