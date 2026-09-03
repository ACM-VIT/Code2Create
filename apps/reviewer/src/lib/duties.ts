import type { DutyIconName } from "@/components/DutyIcon";
import type { Surface } from "@/lib/reviewer-surfaces";
import type { DutyKey } from "@/theme";

export const dutyMeta: Record<Surface, { key: DutyKey; label: string; icon: DutyIconName }> = {
  reviews: { key: "judging", label: "Judging", icon: "judging" },
  attendance: { key: "door", label: "Check-in", icon: "door" },
  floor: { key: "hall", label: "Hall map", icon: "hall" },
  support: { key: "help", label: "Help desk", icon: "help" },
  operations: { key: "pulse", label: "Event status", icon: "pulse" },
  incidents: { key: "incident", label: "Incidents", icon: "incident" },
};

export const floorDuties: Surface[] = ["reviews", "attendance", "floor", "support"];

export const boardDuties: Surface[] = ["operations", "incidents"];

export function splitDuties(surfaces: Surface[]) {
  return {
    floor: floorDuties.filter((surface) => surfaces.includes(surface)),
    board: boardDuties.filter((surface) => surfaces.includes(surface)),
  };
}
