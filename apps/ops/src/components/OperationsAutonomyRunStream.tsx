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
      emptyDescription="The trace contains only the approved planning, read, investigation, critique, and proposal lifecycle."
      emptyTitle="No public lifecycle event was recorded."
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
        detail: 'Convex is rechecking current authority while the agent reads and reasons.',
      }}
    />
  )
}

function terminalCopy(run: AutonomyRun) {
  if (run.state === 'no_op') {
    return {
      completed: {
        title: 'No intervention proposed',
        detail: 'The review completed without finding a supported next action.',
      },
    }
  }
  if (run.state === 'escalated') {
    return {
      completed: {
        title: 'Review escalated',
        detail: 'The authoritative run record marks this review for operator attention.',
      },
    }
  }
  if (run.state === 'failed') {
    return {
      failed: {
        title: 'Autonomous review failed',
        detail: autonomyFailureLabel(run.failureCode),
      },
    }
  }
  if (run.state === 'canceled') {
    if (run.shutdownState === 'pending') {
      return {
        aborted: {
          title: 'Autonomy authority revoked',
          detail: `${autonomyCancellationLabel(run.cancellationReason)} The durable Worker abort is still being retried.`,
        },
      }
    }
    if (run.shutdownState === 'not_required') {
      return {
        aborted: {
          title: 'Autonomous review canceled',
          detail: `${autonomyCancellationLabel(run.cancellationReason)} No Worker submission was admitted, so no abort was required.`,
        },
      }
    }
    return {
      aborted: {
        title: 'Autonomous review stopped',
        detail: `${autonomyCancellationLabel(run.cancellationReason)} The Worker recorded the durable abort request.`,
      },
    }
  }
  return {
    completed: {
      title: 'Autonomous review complete',
      detail: 'The Convex run record is authoritative; any proposed command still requires human review.',
    },
  }
}
