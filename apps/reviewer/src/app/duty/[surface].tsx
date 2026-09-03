import { Redirect, useLocalSearchParams } from "expo-router";

import { DutyScreen } from "@/components/DutyScreen";
import { IncidentPanel } from "@/components/IncidentPanel";
import { PulsePanel } from "@/components/PulsePanel";
import { ReviewPanel } from "@/components/ReviewPanel";
import { ScannerPanel } from "@/components/ScannerPanel";
import { SupportPanel } from "@/components/SupportPanel";
import { useReviewerSession } from "@/components/ReviewerSession";
import { dutyMeta } from "@/lib/duties";
import type { Surface } from "@/lib/reviewer-surfaces";

export default function DutyRoute() {
  const { surface } = useLocalSearchParams<{ surface: string }>();
  const { canCreateSupport, canManageAttention, runtime, surfaces } = useReviewerSession();
  const held = surfaces.find((candidate) => candidate === surface);

  if (!held) {
    return <Redirect href="/" />;
  }

  return (
    <DutyScreen scroll={held !== "attendance"} title={dutyMeta[held].label}>
      {panelFor(held, runtime, canCreateSupport, canManageAttention)}
    </DutyScreen>
  );
}

function panelFor(
  surface: Surface,
  runtime: ReturnType<typeof useReviewerSession>["runtime"],
  canCreateSupport: boolean,
  canManageAttention: boolean,
) {
  if (surface === "reviews") return <ReviewPanel runtime={runtime} />;
  if (surface === "attendance") return <ScannerPanel runtime={runtime} />;
  if (surface === "operations")
    return <PulsePanel canManage={canManageAttention} runtime={runtime} />;
  if (surface === "incidents") return <IncidentPanel runtime={runtime} />;
  return <SupportPanel canCreate={canCreateSupport} runtime={runtime} />;
}
