import type { Doc } from "../_generated/dataModel";
import { fingerprintText } from "./strings";

export function admissionGuidanceForBand(
  guidance: Doc<"admissionPolicyVersions">["criteria"][number]["guidanceByBand"],
  band: Doc<"applications">["experienceBand"],
) {
  if (band === "first_year") return guidance.firstYear;
  if (band === "early_year") return guidance.earlyYear;
  if (band === "later_year") return guidance.laterYear;
  if (band === "postgraduate_or_professional") {
    return guidance.postgraduateOrProfessional;
  }
  return guidance.mixedOrExternal;
}

export function admissionInputFingerprint(args: {
  applicationVersion: number;
  projectVersionId: Doc<"projectVersions">["_id"];
  projectVersion: number;
  initialIdea: string;
  intakeResponses: Doc<"projectVersions">["intakeResponses"];
  admissionInformationResponses: NonNullable<
    Doc<"projectVersions">["admissionInformationResponses"]
  >;
  experienceBand: Doc<"applications">["experienceBand"];
  admissionPolicyVersionId: Doc<"admissionPolicyVersions">["_id"];
  admissionPolicyChecksum: string;
  modelConfigVersionId?: Doc<"admissionModelConfigVersions">["_id"];
  modelConfigChecksum?: string;
}) {
  return fingerprintText(JSON.stringify(args));
}
