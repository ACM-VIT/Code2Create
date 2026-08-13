import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import type { FunctionArgs } from 'convex/server'
import { useCallback } from 'react'

import { eventSlug } from '../lib/config'
import {
  intelligenceConnectionState,
  intelligenceTerminalState,
} from '../lib/intelligenceConversation'
import { useIntelligenceStream } from '../lib/useIntelligenceStream'
import { LiveAgentConsole } from './intelligence'

export function OperationsBriefStream({
  briefId,
  isActive,
}: {
  briefId: FunctionArgs<typeof api.operationsIntelligenceActions.openBriefStream>['briefId']
  isActive: boolean
}) {
  const openStream = useAction(api.operationsIntelligenceActions.openBriefStream)
  const loadAccess = useCallback(
    () => openStream({ eventSlug, briefId }),
    [briefId, openStream],
  )
  const stream = useIntelligenceStream({
    enabled: true,
    loadAccess,
    streamKey: `brief:${briefId}`,
  })
  const connectionState = intelligenceConnectionState({
    accessFailed: stream.accessError !== undefined,
    historyReady: stream.historyReady,
    streamFailed: stream.error !== undefined,
    status: stream.status,
  })

  return (
    <div className="intelligence-brief-stream">
      <LiveAgentConsole
        agentLabel="Brief agent"
        connectionState={connectionState}
        emptyDescription="The trace appears when the brief agent begins reading the frozen health snapshot."
        emptyTitle="Waiting for agent activity."
        historyCanLoadMore={stream.historyCanLoadMore}
        {...stream.historyLoadError === undefined ? {} : { historyLoadError: stream.historyLoadError }}
        historyLoading={stream.historyLoading}
        isStreaming={isActive || stream.status === 'submitted' || stream.status === 'streaming'}
        messages={stream.messages}
        onLoadOlder={stream.loadOlder}
        onReconnect={stream.reconnect}
        showOperatorMessages={false}
        terminalState={intelligenceTerminalState(stream.settlements)}
        terminalCopy={{
          completed: {
            title: 'Trace complete',
            detail: 'The published brief above is the authoritative result.',
          },
          failed: {
            title: 'Brief run did not finish',
            detail: 'The run status above records the failure; an operator may request another brief.',
          },
          aborted: {
            title: 'Brief run stopped',
            detail: 'No further work is running for this brief.',
          },
        }}
        title="Operations brief agent"
        workingCopy={{
          title: 'Preparing brief',
          detail: 'The agent is reading the frozen event snapshot.',
        }}
      />
    </div>
  )
}
