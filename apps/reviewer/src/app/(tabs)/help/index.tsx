import { SupportHome } from "@/components/SupportHome";
import { DutyScreen } from "@/components/DutyScreen";

export default function HelpScreen() {
  return (
    <DutyScreen title="Help" underNativeTabs>
      <SupportHome />
    </DutyScreen>
  );
}
