import type {
  AgentStatus,
  FlueConversationMessage,
  FlueConversationSettlement,
} from '@flue/react'

export type IntelligenceConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'

export type IntelligenceTerminalState = 'none' | 'completed' | 'failed' | 'aborted'

export function intelligenceConnectionState(args: {
  accessFailed: boolean
  historyReady: boolean
  streamFailed: boolean
  status: AgentStatus
}): IntelligenceConnectionState {
  if (args.accessFailed || args.status === 'error') return 'offline'
  if (!args.historyReady) return 'connecting'
  if (args.streamFailed || args.status === 'connecting') return 'reconnecting'
  return 'connected'
}

export function observedSubmissionId(
  messages: readonly FlueConversationMessage[],
  turnId: string,
) {
  return messages.find(
    (message) => message.role === 'user' && message.turnId === turnId,
  )?.submissionId
}

export function latestActiveSubmissionId(
  messages: readonly FlueConversationMessage[],
  settlements: readonly FlueConversationSettlement[],
) {
  const settled = new Set(settlements.map((settlement) => settlement.submissionId))
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const submissionId = messages[index]?.submissionId
    if (submissionId !== undefined && !settled.has(submissionId)) return submissionId
  }
  return undefined
}

export function intelligenceTerminalState(
  settlements: readonly FlueConversationSettlement[],
  submissionId?: string,
): IntelligenceTerminalState {
  const settlement = submissionId === undefined
    ? settlements.at(-1)
    : settlements.find((candidate) => candidate.submissionId === submissionId)
  return settlement?.outcome ?? 'none'
}

export function submissionIsActive(
  settlements: readonly FlueConversationSettlement[],
  submissionId: string | undefined,
) {
  return submissionId !== undefined
    && !settlements.some((settlement) => settlement.submissionId === submissionId)
}
