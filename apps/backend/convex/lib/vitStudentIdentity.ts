export const vitStudentEmailDomain = "vitstudent.ac.in";
export const vitInstitutionName = "Vellore Institute of Technology";

export type VitStudentProfileIdentity = {
  fullName: string;
  registrationNumber: string;
  programmeCode: string;
  yearOfStudy: "first" | "second" | "third" | "fourth" | "fifth_or_later";
};

function studyYearForRegistrationPrefix(prefix: string, eventYear: number) {
  if (!Number.isSafeInteger(eventYear) || eventYear < 2000 || eventYear > 2099) {
    throw new Error("The event year cannot determine a VIT study year.");
  }
  const registrationYear = 2000 + Number(prefix);
  const ordinal = eventYear - registrationYear + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null;
  if (ordinal === 1) return "first" as const;
  if (ordinal === 2) return "second" as const;
  if (ordinal === 3) return "third" as const;
  if (ordinal === 4) return "fourth" as const;
  return "fifth_or_later" as const;
}

export function parseVitStudentGoogleDisplayName(
  displayName: string,
  eventYear: number,
): VitStudentProfileIdentity | null {
  const normalized = displayName.trim().replace(/\s+/g, " ");
  const match = normalized.match(
    /^(.{2,})\s+((\d{2})([A-Za-z]{3})(\d{4}))$/,
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
  const yearOfStudy = studyYearForRegistrationPrefix(registrationPrefix, eventYear);
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
