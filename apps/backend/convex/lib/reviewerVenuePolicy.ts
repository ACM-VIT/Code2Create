import { ConvexError, v } from "convex/values";

export const venuePolicyFields = {
  enabled: v.boolean(),
  name: v.string(),
  latitude: v.number(),
  longitude: v.number(),
  radiusMeters: v.number(),
  startsAt: v.number(),
  endsAt: v.number(),
  absenceGraceMinutes: v.number(),
  callDelayMinutes: v.number(),
};

export const reviewerVenueStatus = v.union(
  v.literal("unknown"),
  v.literal("inside"),
  v.literal("outside"),
  v.literal("left"),
  v.literal("reported_left"),
);

export const locationFreshnessMs = 180_000;
export const venueCallPurpose = "reviewer_venue_absence" as const;
export const venueCallConsentVersion = "reviewer-venue-absence-consent-v1";
export const venueCallScriptVersion = "reviewer-venue-absence-v1";

type VenuePolicy = {
  enabled: boolean;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  startsAt: number;
  endsAt: number;
  absenceGraceMinutes: number;
  callDelayMinutes: number;
};

export function validateVenuePolicy(policy: VenuePolicy) {
  if (
    !policy.name.trim() ||
    policy.name.length > 100 ||
    !validCoordinates(policy.latitude, policy.longitude) ||
    !Number.isFinite(policy.radiusMeters) ||
    policy.radiusMeters < 100 ||
    policy.radiusMeters > 5_000 ||
    !Number.isSafeInteger(policy.startsAt) ||
    !Number.isSafeInteger(policy.endsAt) ||
    policy.endsAt <= policy.startsAt ||
    policy.endsAt - policy.startsAt > 7 * 86_400_000 ||
    !Number.isInteger(policy.absenceGraceMinutes) ||
    policy.absenceGraceMinutes < 2 ||
    policy.absenceGraceMinutes > 60 ||
    !Number.isInteger(policy.callDelayMinutes) ||
    policy.callDelayMinutes < 2 ||
    policy.callDelayMinutes > 120
  )
    throw new ConvexError({
      code: "INVALID_VENUE_POLICY",
      message:
        "Set a venue, a 100–5,000 metre radius, a window of up to seven days, a 2–60 minute absence grace and a 2–120 minute call delay.",
    });
}

export function validCoordinates(latitude: number, longitude: number) {
  return (
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

export function venuePolicyActive(
  policy: Pick<VenuePolicy, "enabled" | "startsAt" | "endsAt">,
  now: number,
) {
  return policy.enabled && now >= policy.startsAt && now < policy.endsAt;
}

export function classifyVenueLocation(
  policy: Pick<VenuePolicy, "latitude" | "longitude" | "radiusMeters">,
  sample: {
    latitude: number;
    longitude: number;
    accuracy: number;
    mocked?: boolean;
  },
): "inside" | "outside" | "uncertain" {
  if (
    !validCoordinates(sample.latitude, sample.longitude) ||
    !Number.isFinite(sample.accuracy) ||
    sample.accuracy < 0
  ) {
    throw new ConvexError({
      code: "INVALID_LOCATION",
      message: "This phone returned an invalid location.",
    });
  }
  if (sample.mocked || sample.accuracy > Math.min(100, policy.radiusMeters / 2))
    return "uncertain";
  const radians = Math.PI / 180;
  const a =
    Math.sin(((sample.latitude - policy.latitude) * radians) / 2) ** 2 +
    Math.cos(policy.latitude * radians) *
      Math.cos(sample.latitude * radians) *
      Math.sin(((sample.longitude - policy.longitude) * radians) / 2) ** 2;
  const distance =
    6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  if (distance + sample.accuracy <= policy.radiusMeters) return "inside";
  if (distance - sample.accuracy > policy.radiusMeters + 25) return "outside";
  return "uncertain";
}
