type VenueStatus = "unknown" | "inside" | "outside" | "left" | "reported_left";

export function venuePresenceLabel(
  status: VenueStatus,
  sampledAt: number | undefined,
  now: number,
) {
  if (status === "reported_left") return "Leaving reported";
  if (sampledAt === undefined || now - sampledAt > 180_000)
    return "Location unavailable";
  return {
    inside: "At venue",
    outside: "Outside venue",
    left: "Outside venue — check needed",
    unknown: "Location unavailable",
  }[status];
}
