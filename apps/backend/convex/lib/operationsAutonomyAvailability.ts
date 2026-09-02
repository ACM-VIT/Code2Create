import type { Doc } from "../_generated/dataModel";

type AutonomyEventWindow = Pick<
  Doc<"events">,
  "status" | "applicationsCloseAt"
>;

export function operationsAutonomyAvailable(
  event: AutonomyEventWindow,
  now: number,
) {
  return event.status === "live" || (
    event.status === "registration_open" && now < event.applicationsCloseAt
  );
}
