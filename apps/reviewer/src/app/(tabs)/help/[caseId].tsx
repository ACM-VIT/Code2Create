import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { useLocalSearchParams } from 'expo-router'

import { DutyScreen } from '@/components/DutyScreen'
import { useReviewerSession } from '@/components/ReviewerSession'
import { SupportCaseDetail } from '@/components/SupportPanel'
import { Meta } from '@/components/ui'

/**
 * One case, pushed. The list already showed its code, so the title bar carries
 * it here rather than the body repeating it.
 *
 * The route parameter arrives as a plain string, so the id is resolved back
 * through the reader's own case list rather than asserted into an id type.
 * Convex serves that list from the same subscription the previous screen holds.
 */
export default function SupportCaseRoute() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>()
  const { eventSlug } = useReviewerSession()
  const cases = useQuery(api.support.mine, { eventSlug })
  const supportCase = cases?.find((row) => row.id === caseId)

  return (
    <DutyScreen title={supportCase?.publicCode ?? 'Case'}>
      {cases === undefined ? <Meta>Opening the case…</Meta> : null}
      {cases !== undefined && !supportCase ? (
        <Meta>That case is no longer yours to read.</Meta>
      ) : null}
      {supportCase ? (
        <SupportCaseDetail eventSlug={eventSlug} supportCaseId={supportCase.id} />
      ) : null}
    </DutyScreen>
  )
}
