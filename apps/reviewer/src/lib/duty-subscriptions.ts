export type DutySurface =
  | "reviews"
  | "attendance"
  | "support"
  | "operations"
  | "incidents";

export function dutySubscriptionPlan(shown: readonly DutySurface[]) {
  return {
    attendance: shown.includes("attendance"),
    support: shown.includes("support"),
    operations: shown.includes("operations"),
    incidents: shown.includes("incidents"),
  };
}
