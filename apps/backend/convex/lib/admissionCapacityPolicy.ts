import { ConvexError, type Infer, v } from "convex/values";

export const admissionTrackCapacityInput = v.object({
  trackVersionId: v.id("trackVersions"),
  participantCapacity: v.number(),
});

export type AdmissionTrackCapacity = Infer<typeof admissionTrackCapacityInput>;

export function normalizeAdmissionTrackCapacities(
  capacities: readonly AdmissionTrackCapacity[],
  overallParticipantCapacity: number,
) {
  if (
    !Number.isSafeInteger(overallParticipantCapacity) ||
    overallParticipantCapacity < 1
  ) {
    throw new ConvexError({
      code: "INVALID_ADMISSION_POLICY",
      message: "Overall participant capacity must be a positive whole number.",
    });
  }
  const trackIds = capacities.map((capacity) => capacity.trackVersionId);
  if (new Set(trackIds).size !== trackIds.length) {
    throw new ConvexError({
      code: "INVALID_ADMISSION_POLICY",
      message: "Each core track can have at most one participant-capacity quota.",
    });
  }
  const normalized = capacities.map((capacity) => {
    if (
      !Number.isSafeInteger(capacity.participantCapacity) ||
      capacity.participantCapacity < 1 ||
      capacity.participantCapacity > overallParticipantCapacity
    ) {
      throw new ConvexError({
        code: "INVALID_ADMISSION_POLICY",
        message: "A track participant quota must be a positive whole number no larger than overall capacity.",
      });
    }
    return {
      trackVersionId: capacity.trackVersionId,
      participantCapacity: capacity.participantCapacity,
    };
  });
  return normalized.sort((left, right) =>
    String(left.trackVersionId).localeCompare(String(right.trackVersionId))
  );
}
