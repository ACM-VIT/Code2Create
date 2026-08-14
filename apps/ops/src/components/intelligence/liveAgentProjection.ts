import type { FlueConversationMessage, FlueConversationPart } from '@flue/react'
import {
  operationsAutonomyPublicLifecycleOperations,
  operationsAutonomyPublicLifecycleStatuses,
  type OperationsAutonomyPublicLifecycleOperation,
  type OperationsAutonomyPublicLifecycleStatus,
} from '@code2create/domain'

export type SafeAgentTimelineItem =
  | Readonly<{
      id: string
      kind: 'operator-text'
      text: string
    }>
  | Readonly<{
      id: string
      kind: 'assistant-text'
      state: 'streaming' | 'done'
      text: string
    }>
  | Readonly<{
      id: string
      kind: 'thinking'
      state: 'streaming' | 'done'
      text: string
    }>
  | Readonly<{
      durationMs?: number
      id: string
      kind: 'tool'
      label: string
      state: 'running' | 'complete' | 'failed'
    }>

type FlueToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>
type AutonomyLifecycleData = {
  operation: OperationsAutonomyPublicLifecycleOperation
  status: OperationsAutonomyPublicLifecycleStatus
  durationMs?: number
}

const maximumVisibleDurationMs = 24 * 60 * 60 * 1_000

export function projectVisibleAgentTimeline(
  messages: readonly FlueConversationMessage[],
  options: { showOperatorMessages: boolean } = { showOperatorMessages: true },
): SafeAgentTimelineItem[] {
  const timeline: SafeAgentTimelineItem[] = []

  for (const message of messages) {
    if (
      options.showOperatorMessages
      && message.role === 'user'
      && message.purpose === 'user'
      && message.display === 'visible'
    ) {
      for (const [partIndex, part] of message.parts.entries()) {
        if (part.type === 'text' && part.text.trim().length > 0) {
          timeline.push({
            id: timelineItemId(message.id, partIndex),
            kind: 'operator-text',
            text: part.text,
          })
        }
      }
      continue
    }

    if (
      message.role !== 'assistant'
      || message.purpose !== 'assistant'
      || message.display !== 'visible'
    ) {
      continue
    }

    const reasoningState = message.parts.some(
      (part) => part.type === 'reasoning' && part.state === 'streaming',
    )
      ? 'streaming'
      : 'done'
    let projectedReasoning = false

    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === 'text') {
        if (part.text.trim().length > 0) {
          timeline.push({
            id: timelineItemId(message.id, partIndex),
            kind: 'assistant-text',
            state: part.state,
            text: part.text,
          })
        }
        continue
      }

      if (part.type === 'reasoning') {
        if (!projectedReasoning) {
          timeline.push({
            id: timelineItemId(message.id, partIndex),
            kind: 'thinking',
            state: reasoningState,
            text: message.parts
              .filter((candidate) => candidate.type === 'reasoning')
              .map((candidate) => candidate.text)
              .join('\n\n')
              .trim(),
          })
          projectedReasoning = true
        }
        continue
      }

      if (part.type === 'data-autonomy-lifecycle') {
        const lifecycle = safeAutonomyLifecycle(part.data)
        if (lifecycle === null) continue
        const durationMs = safeDuration(lifecycle.durationMs)
        timeline.push({
          id: timelineItemId(message.id, partIndex),
          kind: 'tool',
          label: safeAutonomyLifecycleLabel(lifecycle.operation),
          state: lifecycle.status === 'started'
            ? 'running'
            : lifecycle.status === 'completed'
              ? 'complete'
              : 'failed',
          ...(durationMs === undefined ? {} : { durationMs }),
        })
        continue
      }

      if (part.type !== 'dynamic-tool') continue
      const label = safeToolLabel(part.toolName)
      if (label === null) continue
      const durationMs = safeDuration(part.durationMs)
      timeline.push({
        id: timelineItemId(message.id, partIndex),
        kind: 'tool',
        label,
        state: safeToolState(part.state),
        ...(durationMs === undefined ? {} : { durationMs }),
      })
    }
  }

  return timeline
}

function safeAutonomyLifecycle(value: unknown): AutonomyLifecycleData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (!('operation' in value) || !('status' in value)) return null
  const operation = value.operation
  const status = value.status
  if (!isPublicLifecycleOperation(operation) || !isPublicLifecycleStatus(status)) return null
  const durationMs = 'durationMs' in value ? value.durationMs : undefined
  if (durationMs !== undefined && typeof durationMs !== 'number') return null
  return { operation, status, ...(durationMs === undefined ? {} : { durationMs }) }
}

function isPublicLifecycleOperation(
  value: unknown,
): value is OperationsAutonomyPublicLifecycleOperation {
  return operationsAutonomyPublicLifecycleOperations.some((candidate) => candidate === value)
}

function isPublicLifecycleStatus(
  value: unknown,
): value is OperationsAutonomyPublicLifecycleStatus {
  return operationsAutonomyPublicLifecycleStatuses.some((candidate) => candidate === value)
}

function safeAutonomyLifecycleLabel(operation: OperationsAutonomyPublicLifecycleOperation) {
  const label = safeToolLabel(operation)
  if (label === null) throw new Error('The autonomy lifecycle allowlist is incomplete.')
  return label
}

function timelineItemId(messageId: string, partIndex: number) {
  return `agent-timeline-${stableOpaqueToken(messageId)}-${partIndex}`
}

function stableOpaqueToken(value: string) {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

function safeDuration(durationMs: number | undefined) {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined
  }
  return Math.min(Math.round(durationMs), maximumVisibleDurationMs)
}

function safeToolState(state: FlueToolPart['state']): Extract<SafeAgentTimelineItem, {
  kind: 'tool'
}>['state'] {
  if (state === 'input-available') return 'running'
  if (state === 'output-available') return 'complete'
  return 'failed'
}

// Unknown tool names are omitted because names can be authored outside this UI boundary.
function safeToolLabel(toolName: string) {
  switch (toolName) {
    case 'plan_operations':
      return 'Plan operations review'
    case 'read_operations_data':
      return 'Read approved event data'
    case 'investigate_area':
      return 'Investigate event area'
    case 'critique_plan':
      return 'Check evidence and conclusions'
    case 'read_operations_health':
      return 'Read operations health'
    case 'read_operations_attention':
      return 'Read attention queue'
    case 'read_review_rounds':
      return 'Read review rounds'
    case 'read_review_exceptions':
      return 'Read review exceptions'
    case 'read_attendance_counts':
      return 'Read attendance counts'
    case 'read_floor_mapping_progress':
      return 'Read floor progress'
    case 'read_support_load':
      return 'Read support load'
    case 'read_recommendation_history':
      return 'Read recommendation history'
    case 'search_submissions':
      return 'Search submitted ideas'
    case 'read_admission_cohort':
      return 'Read admission cohort'
    case 'propose_recommendation':
      return 'Record recommendation proposal'
    case 'publish_operations_brief':
      return 'Publish operations brief'
    case 'task':
      return 'Investigator agent'
    case 'activate_skill':
      return 'Load operating procedure'
    case 'read_skill_resource':
      return 'Read operating guidance'
    default:
      return null
  }
}
