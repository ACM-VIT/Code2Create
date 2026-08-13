import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { useLocalSearchParams } from 'expo-router'

import { DutyScreen } from '@/components/DutyScreen'
import { useReviewerSession } from '@/components/ReviewerSession'
import { SupportCaseDetail } from '@/components/SupportPanel'
import { Meta } from '@/components/ui'

function normalizedSupportCode(value: string | undefined) {
  return value && value.length > 0 ? value : null
}

export default function SupportCaseRoute() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>()
  const { eventSlug } = useReviewerSession()
  const supportCode = normalizedSupportCode(caseId)
  const detail = useQuery(
    api.support.detailByPublicCode,
    supportCode
      ? { eventSlug, publicCode: supportCode }
      : 'skip',
  )

  return (
    <DutyScreen title={detail?.supportCase.publicCode ?? 'Case'}>
      {supportCode && detail === undefined ? <Meta>Opening the case…</Meta> : null}
      {!supportCode ? (
        <Meta>That case link is invalid.</Meta>
      ) : null}
      {detail ? (
        <SupportCaseDetail
          detail={detail}
          eventSlug={eventSlug}
          supportCaseId={detail.supportCase.id}
        />
      ) : null}
    </DutyScreen>
  )
}
