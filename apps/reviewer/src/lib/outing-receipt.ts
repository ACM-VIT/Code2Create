import type { FunctionReturnType } from "convex/server";
import type { api } from "@code2create/backend/api";

type OutingDecision = NonNullable<FunctionReturnType<typeof api.attendanceActions.recordScan>["outing"]>;

export function outingReceiptMessage(outing: OutingDecision, serverTime: number) {
  switch (outing.status) {
    case "waiting": return `Still waiting · queue position ${outing.position}. Permission has not been granted.`;
    case "required": return "No outing permission. Ask them to request a washroom outing in their dashboard.";
    case "expired": return "Permission expired. Ask them to request an outing again.";
    case "unconfigured": return "Outing capacity is not configured. Ask the operations lead to set it.";
    case "online_required": return "A live connection is required to check outing permission. This departure was not recorded.";
    case "returned": return serverTime > outing.returnBy
      ? "Return recorded after the 15-minute limit. Their outing slot is released."
      : "Return recorded. Their outing slot is released.";
    case "overdue": return "This outing is overdue. Scan their ID on return to release the slot.";
    case "out": return `Permission confirmed · 15-minute outing. Return by ${new Date(outing.returnBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Scan their ID on return.`;
  }
}
