import { SupportPanel } from "@/components/SupportPanel";
import { DutyScreen } from "@/components/DutyScreen";
import { useReviewerSession } from "@/components/ReviewerSession";

export default function HelpScreen() {
  const { canCreateSupport, runtime } = useReviewerSession();
  return (
    <DutyScreen scroll={false} title="Help">
      <SupportPanel canCreate={canCreateSupport} runtime={runtime} />
    </DutyScreen>
  );
}
