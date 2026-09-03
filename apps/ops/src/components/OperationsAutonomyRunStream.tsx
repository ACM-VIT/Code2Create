import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import { useCallback } from 'react'

import { eventSlug } from '../lib/config'
import {
  intelligenceConnectionState,
} from '../lib/intelligenceConversation'
import { useIntelligenceStream } from '../lib/useIntelligenceStream'
import {
  autonomyCancellationLabel,
  autonomyFailureLabel,
  autonomyRunIsActive,
  autonomyRunPhaseLabel,
  autonomyRunTerminalState,
  type AutonomyRun,
} from '../lib/operationsAutonomyPresentation'
import { LiveAgentConsole } from './intelligence'

export function OperationsAutonomyRunStream({
  embedded = true,
  run,
}: {
  embedded?: boolean
  run: AutonomyRun
}) {
  const openStream = useAction(api.operationsAutonomyActions.openRunStream)
  const loadAccess = useCallback(
    () => openStream({ eventSlug, runId: run.runId }),
    [openStream, run.runId],
  )
  const stream = useIntelligenceStream({
    enabled: true,
    loadAccess,
    streamKey: `autonomy:${run.runId}`,
  })
  const connectionState = intelligenceConnectionState({
    accessFailed: stream.accessError !== undefined,
    historyReady: stream.historyReady,
    streamFailed: stream.error !== undefined,
    status: stream.status,
  })

  return (
    <LiveAgentConsole
      agentLabel="Autonomous agent"
      connectionState={connectionState}
      embedded={embedded}
      emptyDescription="This activity shows what the agent planned, checked, investigated, challenged, and proposed."
      emptyTitle="No agent activity was recorded."
      historyCanLoadMore={stream.historyCanLoadMore}
      {...stream.historyLoadError === undefined ? {} : { historyLoadError: stream.historyLoadError }}
      historyLoading={stream.historyLoading}
      isStreaming={autonomyRunIsActive(run.state)}
      messages={stream.messages}
      onLoadOlder={stream.loadOlder}
      onReconnect={stream.reconnect}
      showOperatorMessages={false}
      terminalState={autonomyRunTerminalState(run.state)}
      terminalCopy={terminalCopy(run)}
      workingCopy={{
        title: autonomyRunPhaseLabel(run.phase),
        detail: 'The agent’s access is re-checked while it works.',
      }}
    />
  )
}

function terminalCopy(run: AutonomyRun) {
  if (run.state === 'no_op') {
    return {
      completed: {
        title: 'No action suggested',
        detail: 'The check finished without finding anything to suggest.',
      },
    }
  }
  if (run.state === 'escalated') {
    return {
      completed: {
        title: 'Review escalated',
        detail: 'This check was flagged for an organiser.',
      },
    }
  }
  if (run.state === 'failed') {
    return {
      failed: {
        title: 'Check failed',
        detail: autonomyFailureLabel(run.failureCode),
      },
    }
  }
  if (run.state === 'canceled') {
    if (run.shutdownState === 'pending') {
      return {
        aborted: {
          title: 'Agent access removed',
          detail: `${autonomyCancellationLabel(run.cancellationReason)} The stop request is still being retried.`,
        },
      }
    }
    if (run.shutdownState === 'not_required') {
      return {
        aborted: {
          title: 'Check cancelled',
          detail: `${autonomyCancellationLabel(run.cancellationReason)} The agent never started, so no stop request was needed.`,
        },
      }
    }
    return {
      aborted: {
        title: 'Check stopped',
        detail: `${autonomyCancellationLabel(run.cancellationReason)} The stop request was recorded, and this run no longer has event access.`,
      },
    }
  }
  return {
    completed: {
      title: 'Check complete',
      detail: 'This run is complete. Anything it suggests still needs a person to approve it.',
    },
  }
}
