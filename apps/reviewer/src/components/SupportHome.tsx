import { useState } from "react";
import { useReviewerSession } from "@/components/ReviewerSession";
import { SupportDeskPanel } from "@/components/SupportDeskPanel";
import { SupportPanel } from "@/components/SupportPanel";
import { ChipRow } from "@/components/ui";

export function SupportHome() {
  const {
    canReadSupport,
    canCreateSupport,
    canOpenSupportDesk,
    canCreateStaffSupport,
    eventSlug,
    runtime,
  } = useReviewerSession();
  const [view, setView] = useState<"staff" | "mine">("staff");
  const staffAccess = canOpenSupportDesk || canCreateStaffSupport;
  const staffView = staffAccess && view === "staff";
  return (
    <>
      {staffAccess && (canReadSupport || canCreateSupport) ? (
        <ChipRow
          options={[
            ["staff", "Help desk"],
            ["mine", canReadSupport ? "Your cases" : "Report a problem"],
          ]}
          selected={view}
          onSelect={setView}
        />
      ) : null}
      {staffView ? (
        <SupportDeskPanel
          eventSlug={eventSlug}
          canRead={canOpenSupportDesk}
          canCreate={canCreateStaffSupport}
          canReadOwnCases={canReadSupport}
        />
      ) : (
        <SupportPanel canRead={canReadSupport} canCreate={canCreateSupport} runtime={runtime} />
      )}
    </>
  );
}
