import type { SubmittedIntake } from "../types";

type ApplicationState = SubmittedIntake["application"]["state"];

export type AdmissionResultOutcome = "selected" | "waitlisted" | "not_selected";

export function admissionResultOutcome(
  state: ApplicationState,
): AdmissionResultOutcome | null {
  switch (state) {
    case "accepted":
    case "offer_sent":
    case "confirmed":
      return "selected";
    case "waitlisted":
      return "waitlisted";
    case "declined":
      return "not_selected";
    default:
      return null;
  }
}

export function admissionResultRevealKey(
  applicationId: string,
  outcome: AdmissionResultOutcome,
) {
  return `c2c:admission-result:${applicationId}:${outcome}`;
}
