export type VenueStatus =
  "unknown" | "inside" | "outside" | "left" | "reported_left";

export const venueStatusLabels: Record<VenueStatus, string> = {
  unknown: "Location unavailable",
  inside: "At venue",
  outside: "Outside venue",
  left: "Outside venue — check needed",
  reported_left: "Leaving reported",
};

export function visibleVenueStatus(
  status: VenueStatus | undefined,
  sampledAt: number | undefined,
  now: number,
): VenueStatus {
  if (status === "reported_left") return status;
  if (sampledAt === undefined || now - sampledAt > 180_000) return "unknown";
  return status ?? "unknown";
}
