import {
  findVitHostelResidenceCatalogEntry,
  isVitHostelResidenceCatalogBlock,
  isVitHostelRoomNumber,
  normalizeVitHostelRoomNumberInput,
  type VitHostelResidenceCatalogEntry,
} from "@code2create/domain";
import { ConvexError } from "convex/values";

import type { ProfileFieldMode } from "./participantPolicy";

export function parsedHostelDetails(
  participantClass: "vit_student" | "external_participant",
  residenceValue: string | undefined,
  roomValue: string | undefined,
  mode: ProfileFieldMode,
  catalog: readonly VitHostelResidenceCatalogEntry[],
) {
  if (participantClass !== "vit_student" || mode === "not_collected") {
    return { vitHostelResidence: undefined, vitHostelRoomNumber: undefined };
  }
  const residence = parsedHostelResidence(catalog, residenceValue);
  if (mode === "required" && residence === undefined) {
    throw new ConvexError({
      code: "PROFILE_FIELD_REQUIRED",
      message: "Hostel residence is required by the current participant policy.",
    });
  }
  if (residence === undefined) {
    if (normalizeVitHostelRoomNumberInput(roomValue ?? "")) {
      throw new ConvexError({
        code: "HOSTEL_ROOM_WITHOUT_BLOCK",
        message: "Choose a hostel block before entering a room number.",
      });
    }
    return { vitHostelResidence: undefined, vitHostelRoomNumber: undefined };
  }
  if (!isVitHostelResidenceCatalogBlock(residence)) {
    if (normalizeVitHostelRoomNumberInput(roomValue ?? "")) {
      throw new ConvexError({
        code: "DAY_SCHOLAR_HAS_NO_ROOM",
        message: "Day scholars do not have a hostel room number.",
      });
    }
    return { vitHostelResidence: residence.stableKey, vitHostelRoomNumber: undefined };
  }
  const vitHostelRoomNumber = parsedHostelRoomNumber(roomValue);
  if (vitHostelRoomNumber === undefined) {
    throw new ConvexError({
      code: "HOSTEL_ROOM_REQUIRED",
      message: "Enter your hostel room number.",
    });
  }
  return { vitHostelResidence: residence.stableKey, vitHostelRoomNumber };
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
      message: "Choose a current VIT hostel block or day scholar.",
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
