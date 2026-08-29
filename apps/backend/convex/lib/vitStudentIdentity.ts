export const vitStudentEmailDomain = "vitstudent.ac.in";
export const vitInstitutionName = "Vellore Institute of Technology";

export type VitStudentProfileIdentity = {
  fullName: string;
  registrationNumber: string;
  programmeCode: string;
  yearOfStudy: "first" | "second" | "third" | "fourth";
};

function studyYearForRegistrationPrefix(prefix: string) {
  switch (prefix) {
    case "26":
      return "first" as const;
    case "25":
      return "second" as const;
    case "24":
      return "third" as const;
    case "23":
      return "fourth" as const;
    default:
      return null;
  }
}

export function parseVitStudentGoogleDisplayName(
  displayName: string,
): VitStudentProfileIdentity | null {
  const normalized = displayName.trim().replace(/\s+/g, " ");
  const match = normalized.match(
    /^(.{2,})\s+((23|24|25|26)([A-Za-z]{3})(\d{4}))$/,
  );
  if (!match) return null;
  const fullName = match[1];
  const registrationPrefix = match[3];
  const programmeCode = match[4];
  const registrationSerial = match[5];
  if (
    !fullName ||
    !registrationPrefix ||
    !programmeCode ||
    !registrationSerial
  ) {
    return null;
  }
  const yearOfStudy = studyYearForRegistrationPrefix(registrationPrefix);
  if (!yearOfStudy) return null;
  const normalizedProgrammeCode = programmeCode.toUpperCase();
  return {
    fullName,
    registrationNumber: `${registrationPrefix}${normalizedProgrammeCode}${registrationSerial}`,
    programmeCode: normalizedProgrammeCode,
    yearOfStudy,
  };
}

export function isApprovedVitStudentIdentity(args: {
  verifiedEmail: string;
  hostedDomain?: string;
  allowedDomains: readonly string[];
}) {
  const email = args.verifiedEmail.trim().toLowerCase();
  const hostedDomain = args.hostedDomain?.trim().toLowerCase();
  return (
    email.endsWith(`@${vitStudentEmailDomain}`) &&
    hostedDomain === vitStudentEmailDomain &&
    args.allowedDomains.some(
      (domain) => domain.trim().toLowerCase() === vitStudentEmailDomain,
    )
  );
}
