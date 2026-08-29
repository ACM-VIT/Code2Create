import { describe, expect, test } from "vitest";

import {
  isApprovedVitStudentIdentity,
  vitInstitutionName,
} from "./vitStudentIdentity.ts";

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
});
