import { Redirect } from 'expo-router'

import { DutyBoard } from '@/components/DutyBoard'
import { useReviewerSession } from '@/components/ReviewerSession'
import { splitDuties } from '@/lib/duties'

export default function DutiesScreen() {
  const { surfaces } = useReviewerSession()
  const duties = splitDuties(surfaces)
  if (duties.floor.length === 0) {
    if (duties.board.length > 0) return <Redirect href="/(tabs)/board" />
    if (surfaces.includes('support')) return <Redirect href="/(tabs)/help" />
    return <Redirect href="/(tabs)/account" />
  }
  return <DutyBoard group="floor" />
}
