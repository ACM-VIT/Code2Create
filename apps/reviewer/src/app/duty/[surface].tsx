import { useLocalSearchParams } from 'expo-router'

import { DutyScreen } from '@/components/DutyScreen'
import { FloorMappingPanel } from '@/components/FloorMappingPanel'
import { IncidentPanel } from '@/components/IncidentPanel'
import { PulsePanel } from '@/components/PulsePanel'
import { ReviewPanel } from '@/components/ReviewPanel'
import { ScannerPanel } from '@/components/ScannerPanel'
import { SupportPanel } from '@/components/SupportPanel'
import { useReviewerSession, type Surface } from '@/components/ReviewerSession'
import { dutyMeta } from '@/app/(tabs)/index'

/**
 * One pushed screen per duty. Opening one replaces the grid entirely, so a
 * person mid-scan is never one mistap away from the floor mapper — and the
 * platform's own back gesture is how they leave.
 */
export default function DutyRoute() {
  const { surface } = useLocalSearchParams<{ surface: string }>()
  const { canCreateSupport, canManageAttention, runtime, surfaces } = useReviewerSession()
  const held = surfaces.find((candidate) => candidate === surface)

  if (!held) {
    return <DutyScreen title="Not yours">{null}</DutyScreen>
  }

  return (
    // The door and the hall each own their whole frame: on one the camera is
    // the screen, on the other the room is. Neither is a field inside a form.
    <DutyScreen
      scroll={held !== 'attendance' && held !== 'floor'}
      title={dutyMeta[held].label}
    >
      {panelFor(held, runtime, canCreateSupport, canManageAttention)}
    </DutyScreen>
  )
}

function panelFor(
  surface: Surface,
  runtime: ReturnType<typeof useReviewerSession>['runtime'],
  canCreateSupport: boolean,
  canManageAttention: boolean,
) {
  if (surface === 'reviews') return <ReviewPanel runtime={runtime} />
  if (surface === 'attendance') return <ScannerPanel runtime={runtime} />
  if (surface === 'floor') return <FloorMappingPanel runtime={runtime} />
  if (surface === 'operations') return <PulsePanel canManage={canManageAttention} runtime={runtime} />
  if (surface === 'incidents') return <IncidentPanel runtime={runtime} />
  return <SupportPanel canCreate={canCreateSupport} runtime={runtime} />
}
