import {
  findVitHostelResidenceCatalogEntry,
  isVitHostelRoomNumber,
  normalizeVitHostelRoomNumberInput,
  type ParticipantGender,
  type VitHostelResidenceCatalogEntry,
  type VitResidenceType,
} from "@code2create/domain";
import { ConvexError } from "convex/values";

export function parsedHostelDetails(
  participantClass: "vit_student" | "external_participant",
  gender: ParticipantGender,
  residenceType: VitResidenceType | undefined,
  residenceValue: string | undefined,
  roomValue: string | undefined,
  catalog: readonly VitHostelResidenceCatalogEntry[],
) {
  if (participantClass !== "vit_student") {
    return {
      vitResidenceType: undefined,
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    };
  }
  if (residenceType === undefined) {
    throw new ConvexError({
      code: "PROFILE_FIELD_REQUIRED",
      message: "Choose whether you are a day scholar or hosteller.",
    });
  }
  if (residenceType === "day_scholar") {
    if (
      residenceValue?.trim()
      || normalizeVitHostelRoomNumberInput(roomValue ?? "")
    ) {
      throw new ConvexError({
        code: "DAY_SCHOLAR_HAS_NO_HOSTEL_DETAILS",
        message: "Day scholars do not have a hostel block or room number.",
      });
    }
    return {
      vitResidenceType: residenceType,
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    };
  }
  const residence = parsedHostelResidence(catalog, residenceValue);
  if (residence === undefined) {
    throw new ConvexError({
      code: "HOSTEL_BLOCK_REQUIRED",
      message: "Choose your hostel block.",
    });
  }
  const expectedKind = gender === "male" ? "mens" : "ladies";
  if (residence.kind !== expectedKind) {
    throw new ConvexError({
      code: "HOSTEL_BLOCK_GENDER_MISMATCH",
      message: `Choose a ${gender === "male" ? "men's" : "ladies'"} hostel block.`,
    });
  }
  const vitHostelRoomNumber = parsedHostelRoomNumber(roomValue);
  if (vitHostelRoomNumber === undefined) {
    throw new ConvexError({
      code: "HOSTEL_ROOM_REQUIRED",
      message: "Enter your hostel room number.",
    });
  }
  return {
    vitResidenceType: residenceType,
    vitHostelResidence: residence.stableKey,
    vitHostelRoomNumber,
  };
}

function parsedHostelResidence(
  catalog: readonly VitHostelResidenceCatalogEntry[],
  value: string | undefined,
) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const residence = findVitHostelResidenceCatalogEntry(catalog, normalized);
  if (!residence) {
    throw new ConvexError({
      code: "INVALID_HOSTEL_RESIDENCE",
      message: "Choose a current VIT hostel block.",
    });
  }
  return residence;
}

function parsedHostelRoomNumber(value: string | undefined) {
  const normalized = normalizeVitHostelRoomNumberInput(value ?? "");
  if (!normalized) return undefined;
  if (!isVitHostelRoomNumber(normalized)) {
    throw new ConvexError({
      code: "INVALID_HOSTEL_ROOM_NUMBER",
      message: "Room number must be 1 to 10 letters, digits, or hyphens and include a digit.",
    });
  }
  return normalized;
}
