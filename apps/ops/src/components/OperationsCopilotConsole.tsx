import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useCallback, useEffect, useState } from 'react'

import { eventSlug } from '../lib/config'
import {
  intelligenceConnectionState,
  intelligenceTerminalState,
  latestActiveSubmissionId,
  observedSubmissionId,
  submissionIsActive,
} from '../lib/intelligenceConversation'
import { useIntelligenceStream } from '../lib/useIntelligenceStream'
import { useOperationRunner } from '../lib/operations'
import { LiveAgentConsole } from './intelligence'

type TurnResult = FunctionReturnType<
  typeof api.operationsIntelligenceActions.submitCopilotTurn
>

type PendingTurn = {
  turnId: string
}

export function OperationsCopilotConsole({
  canGenerate,
  canRead,
}: {
  canGenerate: boolean
  canRead: boolean
}) {
  const openStream = useAction(api.operationsIntelligenceActions.openCopilotStream)
  const submitTurn = useAction(api.operationsIntelligenceActions.submitCopilotTurn)
  const loadAccess = useCallback(() => openStream({ eventSlug }), [openStream])
  const stream = useIntelligenceStream({
    enabled: canRead,
    loadAccess,
    streamKey: `copilot:${eventSlug}`,
  })
  const reconnectStream = stream.reconnect
  const operations = useOperationRunner<TurnResult>()
  const [pendingTurn, setPendingTurn] = useState<PendingTurn>()
  const [activeSubmissionId, setActiveSubmissionId] = useState<string>()
  const [composerResetKey, setComposerResetKey] = useState(0)

  const clearPendingTurn = useCallback(() => {
    setPendingTurn(undefined)
  }, [])

  useEffect(() => {
    if (pendingTurn === undefined || !canRead) return
    const submissionId = observedSubmissionId(stream.messages, pendingTurn.turnId)
    if (submissionId === undefined) return
    operations.confirmObservedSuccess('copilot-turn')
    setActiveSubmissionId(submissionId)
    clearPendingTurn()
    setComposerResetKey((key) => key + 1)
  }, [canRead, clearPendingTurn, operations, pendingTurn, stream.messages])

  const observedActiveSubmissionId = latestActiveSubmissionId(
    stream.messages,
    stream.settlements,
  )
  const durableActiveSubmissionId = observedActiveSubmissionId ?? activeSubmissionId

  const submitPrompt = useCallback(async (prompt: string) => {
    try {
      const result = await operations.run('copilot-turn', (turnId) => {
        const command = { turnId }
        setPendingTurn(command)
        return () => submitTurn({ eventSlug, turnId, message: prompt })
      })
      if (canRead) setActiveSubmissionId(result.submissionId)
      clearPendingTurn()
      if (canRead) reconnectStream()
    } catch (caught) {
      if (!operations.hasPending('copilot-turn')) clearPendingTurn()
      throw caught
    }
  }, [canRead, clearPendingTurn, operations, reconnectStream, submitTurn])

  const hasPendingTurn = operations.hasPending('copilot-turn')
  const active = submissionIsActive(stream.settlements, durableActiveSubmissionId)
  const isStreaming = stream.status === 'submitted' || stream.status === 'streaming' || active
  const connectionState = canRead
    ? intelligenceConnectionState({
        accessFailed: stream.accessError !== undefined,
        historyReady: stream.historyReady,
        streamFailed: stream.error !== undefined,
        status: stream.status,
      })
    : 'connected'
  const terminalState = intelligenceTerminalState(
    stream.settlements,
    durableActiveSubmissionId,
  )

  return (
    <LiveAgentConsole
      composerDisabled={!canGenerate}
      composerPendingConfirmation={hasPendingTurn}
      composerRequiresConnection={false}
      composerResetKey={composerResetKey}
      connectionState={connectionState}
      emptyDescription={canRead
        ? 'Ask about review flow, attendance, floor mapping, support load, or admissions.'
        : 'You can send a question, but intelligence read access is required to view its response.'}
      emptyTitle={canRead ? 'Start with the live event.' : 'Ask an event question.'}
      historyCanLoadMore={canRead && stream.historyCanLoadMore}
      {...canRead && stream.historyLoadError !== undefined
        ? { historyLoadError: stream.historyLoadError }
        : {}}
      historyLoading={canRead && stream.historyLoading}
      isStreaming={isStreaming}
      messages={canRead ? stream.messages : []}
      {...canRead ? { onLoadOlder: stream.loadOlder } : {}}
      onReconnect={stream.reconnect}
      {...canGenerate ? { onSubmitPrompt: submitPrompt } : {}}
      terminalState={canRead ? terminalState : 'none'}
    />
  )
}
