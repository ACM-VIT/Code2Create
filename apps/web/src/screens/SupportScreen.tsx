import type { ReactNode } from 'react'
import { GuideConversation } from '../components/guide/GuideConversation'
import { PortalScene } from '../components/portal/PortalScene'

/** Help is one conversation with the Guide and, when needed, the event team. */
export function SupportScreen({ header }: { header: ReactNode }) {
  return (
    <PortalScene tree="left" header={header} fill>
      <GuideConversation />
    </PortalScene>
  )
}
