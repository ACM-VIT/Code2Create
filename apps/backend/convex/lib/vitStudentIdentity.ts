export const vitStudentEmailDomain = "vitstudent.ac.in";
export const vitInstitutionName = "Vellore Institute of Technology, Vellore";

export type VitStudentProfileIdentity = {
  fullName: string;
  registrationNumber: string;
  programmeCode: string;
  yearOfStudy: "first" | "second" | "third" | "fourth" | "fifth_or_later";
};

export type ParsedVitRegistrationNumber = {
  registrationNumber: string;
  programmeCode: string;
  yearOfStudy: VitStudentProfileIdentity["yearOfStudy"];
};

const vitRegistrationNumberPattern = /^(\d{2})([A-Za-z]{3})(\d{4})$/;

export function vitIdentityReferenceYear(event: {
  timezone: string;
  startsAt?: number;
  applicationsCloseAt: number;
}) {
  const referenceAt = event.startsAt ?? event.applicationsCloseAt;
  return Number(new Intl.DateTimeFormat("en", {
    timeZone: event.timezone,
    year: "numeric",
  }).format(new Date(referenceAt)));
}

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

export function parseVitRegistrationNumber(
  value: string,
  eventYear: number,
): ParsedVitRegistrationNumber | null {
  const match = value.trim().match(vitRegistrationNumberPattern);
  if (!match) return null;
  const registrationPrefix = match[1];
  const programmeCode = match[2];
  const registrationSerial = match[3];
  if (!registrationPrefix || !programmeCode || !registrationSerial) return null;
  const yearOfStudy = studyYearForRegistrationPrefix(registrationPrefix, eventYear);
  if (!yearOfStudy) return null;
  const normalizedProgrammeCode = programmeCode.toUpperCase();
  return {
    registrationNumber: `${registrationPrefix}${normalizedProgrammeCode}${registrationSerial}`,
    programmeCode: normalizedProgrammeCode,
    yearOfStudy,
  };
}

export function parseVitStudentGoogleDisplayName(
  displayName: string,
  eventYear: number,
): VitStudentProfileIdentity | null {
  const normalized = displayName.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(.{2,})\s+(\d{2}[A-Za-z]{3}\d{4})$/);
  if (!match) return null;
  const fullName = match[1];
  const rawRegistrationNumber = match[2];
  if (!fullName || !rawRegistrationNumber) return null;
  const parsed = parseVitRegistrationNumber(rawRegistrationNumber, eventYear);
  if (!parsed) return null;
  return {
    fullName,
    registrationNumber: parsed.registrationNumber,
    programmeCode: parsed.programmeCode,
    yearOfStudy: parsed.yearOfStudy,
  };
}

export function isApprovedVitStudentIdentity(args: {
  verifiedEmail: string;
  hostedDomain?: string;
  allowedDomains: readonly string[];
}) {
  const hostedDomain = args.hostedDomain?.trim().toLowerCase();
  return (
    isVitStudentEmailAddress(args.verifiedEmail, args.allowedDomains) &&
    hostedDomain === vitStudentEmailDomain
  );
}

export function isVitStudentEmailAddress(
  verifiedEmail: string,
  allowedDomains: readonly string[],
) {
  const email = verifiedEmail.trim().toLowerCase();
  return email.endsWith(`@${vitStudentEmailDomain}`) && allowedDomains.some(
    (domain) => domain.trim().toLowerCase() === vitStudentEmailDomain,
  );
}
