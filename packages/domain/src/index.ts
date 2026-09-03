export const participantClasses = ["vit_student", "external_participant"] as const;
export type ParticipantClass = (typeof participantClasses)[number];

export const participantGenders = ["male", "female"] as const;
export type ParticipantGender = (typeof participantGenders)[number];

export const vitResidenceTypes = ["day_scholar", "hosteller"] as const;
export type VitResidenceType = (typeof vitResidenceTypes)[number];

export const studyYears = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth_or_later",
  "postgraduate",
  "not_applicable",
] as const;
export type StudyYear = (typeof studyYears)[number];

export const memberRoles = ["lead", "member"] as const;
export type MemberRole = (typeof memberRoles)[number];

export const applicationDecisions = ["accept", "waitlist", "decline", "needs_information"] as const;
export type ApplicationDecision = (typeof applicationDecisions)[number];

export {
  defaultParticipantEmailTemplates,
  participantEmailTemplateKeys,
  participantEmailTemplateLabels,
  type ParticipantEmailTemplate,
  type ParticipantEmailTemplateKey,
} from "./participantEmailTemplates.ts";

export const admissionRecommendationOutcomes = [
  "recommend_accept",
  "recommend_waitlist",
  "recommend_decline",
  "needs_human_review",
] as const;
export type AdmissionRecommendationOutcome = (typeof admissionRecommendationOutcomes)[number];

export const repositoryKinds = [
  "full_product",
  "frontend",
  "backend_api",
  "mobile_app",
  "desktop_app",
  "ai_ml",
  "data_pipeline",
  "hardware_firmware",
  "infrastructure",
  "library_sdk",
  "docs_research",
  "other",
] as const;
export type RepositoryKind = (typeof repositoryKinds)[number];

export const barcodeSymbologies = [
  "aztec",
  "ean13",
  "ean8",
  "qr",
  "pdf417",
  "upc_e",
  "datamatrix",
  "code39",
  "code93",
  "itf14",
  "codabar",
  "code128",
  "upc_a",
] as const;
export type BarcodeSymbology = (typeof barcodeSymbologies)[number];

const portalQrPrefix = "c2c:attendance:portal:v1:";
const badgeQrPrefix = "c2c:attendance:badge:v1:";
const attendanceBearerPattern = /^[A-Za-z0-9_-]{43}$/u;

export type AttendanceQr =
  | { kind: "portal_qr"; bearer: string }
  | { kind: "badge_qr"; bearer: string };

export function attendanceQrPayload(credential: AttendanceQr) {
  if (!attendanceBearerPattern.test(credential.bearer)) {
    throw new Error("An attendance bearer must be 32-byte base64url without padding.");
  }
  const prefix = credential.kind === "portal_qr" ? portalQrPrefix : badgeQrPrefix;
  return `${prefix}${credential.bearer}`;
}

export function parseAttendanceQrPayload(payload: string): AttendanceQr | null {
  if (payload.startsWith(portalQrPrefix)) {
    const bearer = payload.slice(portalQrPrefix.length);
    return attendanceBearerPattern.test(bearer) ? { kind: "portal_qr", bearer } : null;
  }
  if (payload.startsWith(badgeQrPrefix)) {
    const bearer = payload.slice(badgeQrPrefix.length);
    return attendanceBearerPattern.test(bearer) ? { kind: "badge_qr", bearer } : null;
  }
  return null;
}

export function attendanceBadgeReference(bearer: string) {
  if (!attendanceBearerPattern.test(bearer)) {
    throw new Error("An attendance badge bearer must be 32-byte base64url without padding.");
  }
  return `C2C-${bearer.slice(0, 4).toUpperCase()}-${bearer.slice(4, 8).toUpperCase()}`;
}

export function findBarcodeSymbology(value: string): BarcodeSymbology | null {
  return barcodeSymbologies.find((symbology) => symbology === value) ?? null;
}

export * from "./intelligence.ts";
export * from "./intelligenceRecommendations.ts";
export * from "./operationsAutonomy.ts";
export * from "./email.ts";
export * from "./voice.ts";
export * from "./hostel.ts";
export * from "./labels.ts";
export * from "./eventStage.ts";
export * from "./synesthesia.ts";
export * from "./permissions.ts";
export * from "./operationsEpisodes.ts";
export * from "./ideaIntelligence.ts";
export * from "./ideaIntake.ts";
export * from "./intelligenceAgents.ts";
export * from "./participantProfile.ts";
