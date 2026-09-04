import { useState } from "react";
import { useReviewerSession } from "@/components/ReviewerSession";
import { SupportDeskPanel } from "@/components/SupportDeskPanel";
import { SupportPanel } from "@/components/SupportPanel";
import { ChipRow } from "@/components/ui";

export function SupportHome() {
  const { canCreateSupport, canOpenSupportDesk, eventSlug, runtime } = useReviewerSession();
  const [view, setView] = useState<"staff" | "mine">("staff");
  const staffView = canOpenSupportDesk && view === "staff";
  return (
    <>
      {canOpenSupportDesk ? (
        <ChipRow
          options={[
            ["staff", "Help desk"],
            ["mine", "Your cases"],
          ]}
          selected={view}
          onSelect={setView}
        />
      ) : null}
      {staffView ? (
        <SupportDeskPanel eventSlug={eventSlug} />
      ) : (
        <SupportPanel canCreate={canCreateSupport} runtime={runtime} />
      )}
    </>
  );
}
