import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlueConversationMessage, FlueConversationPart } from '@flue/react'

import { projectVisibleAgentTimeline } from './liveAgentProjection.ts'

const privateValues = {
  data: 'PRIVATE_DATA_PAYLOAD',
  file: 'PRIVATE_FILE_NAME',
  hiddenAssistant: 'PRIVATE_HIDDEN_ASSISTANT',
  identifier: 'PRIVATE_MESSAGE_IDENTIFIER',
  metadata: 'PRIVATE_METADATA',
  reasoning: 'PRIVATE_REASONING',
  system: 'PRIVATE_SYSTEM_MESSAGE',
  toolError: 'PRIVATE_TOOL_ERROR',
  toolInput: 'PRIVATE_TOOL_INPUT',
  toolOutput: 'PRIVATE_TOOL_OUTPUT',
  unknownTool: 'PRIVATE_UNKNOWN_TOOL_NAME',
  hiddenUser: 'PRIVATE_HIDDEN_USER_MESSAGE',
} as const

let messageSequence = 0

test('projects only visible assistant text and safe lifecycle information', () => {
  const unsafeParts: FlueConversationPart[] = [
    { type: 'reasoning', text: privateValues.reasoning, state: 'done' },
    { type: 'data-private', data: { value: privateValues.data } },
    {
      type: 'file',
      mediaType: 'text/plain',
      filename: privateValues.file,
      url: `https://example.test/${privateValues.file}`,
    },
    {
      type: 'dynamic-tool',
      toolName: 'read_operations_health',
      toolCallId: privateValues.identifier,
      state: 'output-available',
      input: { value: privateValues.toolInput },
      output: { value: privateValues.toolOutput },
      durationMs: 1_240,
    },
    {
      type: 'dynamic-tool',
      toolName: 'read_support_load',
      toolCallId: 'safe-call-id-is-still-not-projected',
      state: 'output-error',
      input: { value: privateValues.toolInput },
      errorText: privateValues.toolError,
      durationMs: 800,
    },
    {
      type: 'dynamic-tool',
      toolName: privateValues.unknownTool,
      toolCallId: 'unknown-call',
      state: 'input-available',
      input: { value: privateValues.toolInput },
    },
    { type: 'text', text: 'Visible operational answer.', state: 'done' },
  ]
  const messages: FlueConversationMessage[] = [
    message('user', 'user', 'visible', [
      { type: 'text', text: 'Which queue needs attention?', state: 'done' },
      { type: 'file', mediaType: 'text/plain', filename: privateValues.file },
    ]),
    message('user', 'user', 'hidden', [
      { type: 'text', text: privateValues.hiddenUser, state: 'done' },
    ]),
    message('system', 'dispatch', 'hidden', [
      { type: 'text', text: privateValues.system, state: 'done' },
    ]),
    message('assistant', 'assistant', 'hidden', [
      { type: 'text', text: privateValues.hiddenAssistant, state: 'done' },
    ]),
    message('assistant', 'assistant', 'visible', unsafeParts),
  ]

  const timeline = projectVisibleAgentTimeline(messages)
  const serialized = JSON.stringify(timeline)

  assert.equal(new Set(timeline.map((item) => item.id)).size, timeline.length)
  assert.deepEqual(timelineContent(timeline), [
    {
      kind: 'operator-text',
      text: 'Which queue needs attention?',
    },
    { kind: 'thinking', state: 'done' },
    {
      kind: 'tool',
      label: 'Read operations health',
      state: 'complete',
      durationMs: 1_240,
    },
    {
      kind: 'tool',
      label: 'Read support load',
      state: 'failed',
      durationMs: 800,
    },
    {
      kind: 'assistant-text',
      state: 'done',
      text: 'Visible operational answer.',
    },
  ])
  assert.equal(serialized.includes('PRIVATE_'), false)
  for (const privateValue of Object.values(privateValues)) {
    assert.equal(serialized.includes(privateValue), false, `projected ${privateValue}`)
  }
})

test('requires the assistant role, purpose, and visible display together', () => {
  const messages: FlueConversationMessage[] = [
    message('assistant', 'advisory', 'visible', [
      { type: 'text', text: 'advisory secret', state: 'done' },
    ]),
    message('assistant', 'assistant', 'diagnostic', [
      { type: 'text', text: 'diagnostic secret', state: 'done' },
    ]),
    message('system', 'assistant', 'visible', [
      { type: 'text', text: 'system-role secret', state: 'done' },
    ]),
    message('user', 'assistant', 'visible', [
      { type: 'text', text: 'wrong-purpose user secret', state: 'done' },
    ]),
  ]

  assert.deepEqual(projectVisibleAgentTimeline(messages), [])
})

test('omits even visible operator text for non-conversational agent runs', () => {
  const messages: FlueConversationMessage[] = [
    message('user', 'user', 'visible', [
      { type: 'text', text: privateValues.hiddenUser, state: 'done' },
    ]),
    message('assistant', 'assistant', 'visible', [
      { type: 'text', text: 'Safe brief progress.', state: 'done' },
    ]),
  ]

  const timeline = projectVisibleAgentTimeline(messages, { showOperatorMessages: false })
  assert.equal(JSON.stringify(timeline).includes(privateValues.hiddenUser), false)
  assert.deepEqual(timelineContent(timeline), [
    {
      kind: 'assistant-text',
      state: 'done',
      text: 'Safe brief progress.',
    },
  ])
})

test('projects the real sanitized autonomy lifecycle data parts', () => {
  const messages: FlueConversationMessage[] = [message('assistant', 'assistant', 'visible', [
    lifecyclePart('plan_operations', 'started'),
    lifecyclePart('plan_operations', 'completed', 820),
    lifecyclePart('read_operations_data', 'completed'),
    lifecyclePart('investigate_area', 'failed'),
    lifecyclePart('critique_plan', 'completed'),
    lifecyclePart('propose_recommendation', 'completed'),
    { type: 'data-autonomy-lifecycle', data: { operation: 'run_arbitrary_command', status: 'completed' } },
  ])]
  assert.deepEqual(timelineContent(projectVisibleAgentTimeline(messages)), [
    { kind: 'tool', label: 'Plan operations review', state: 'running' },
    { kind: 'tool', label: 'Plan operations review', state: 'complete', durationMs: 820 },
    { kind: 'tool', label: 'Read approved event data', state: 'complete' },
    { kind: 'tool', label: 'Investigate event area', state: 'failed' },
    { kind: 'tool', label: 'Check evidence and conclusions', state: 'complete' },
    { kind: 'tool', label: 'Record recommendation proposal', state: 'complete' },
  ])
})

test('consolidates reasoning without retaining its text and sanitizes duration values', () => {
  const messages: FlueConversationMessage[] = [
    message('assistant', 'assistant', 'visible', [
      { type: 'reasoning', text: 'first private thought', state: 'done' },
      { type: 'reasoning', text: 'second private thought', state: 'streaming' },
      {
        type: 'dynamic-tool',
        toolName: 'task',
        toolCallId: 'private-task-call-id',
        state: 'output-available',
        input: { prompt: 'private delegated task prompt' },
        output: 'private delegated task result',
        durationMs: Number.POSITIVE_INFINITY,
      },
    ]),
  ]

  assert.deepEqual(timelineContent(projectVisibleAgentTimeline(messages)), [
    { kind: 'thinking', state: 'streaming' },
    {
      kind: 'tool',
      label: 'Investigator agent',
      state: 'complete',
    },
  ])
})

test('keeps opaque timeline identities stable when older history is prepended', () => {
  const recentMessageId = 'PRIVATE_RECENT_MESSAGE_IDENTIFIER'
  const olderMessageId = 'PRIVATE_OLDER_MESSAGE_IDENTIFIER'
  const recent = message('assistant', 'assistant', 'visible', [
    { type: 'text', text: 'Current activity.', state: 'done' },
  ], recentMessageId)

  const beforePrepend = projectVisibleAgentTimeline([recent])
  const afterPrepend = projectVisibleAgentTimeline([
    message('assistant', 'assistant', 'visible', [
      { type: 'text', text: 'Earlier activity.', state: 'done' },
    ], olderMessageId),
    recent,
  ])
  const currentAfterPrepend = afterPrepend.find(
    (item) => item.kind === 'assistant-text' && item.text === 'Current activity.',
  )

  assert.equal(currentAfterPrepend?.id, beforePrepend[0]?.id)
  assert.equal(new Set(afterPrepend.map((item) => item.id)).size, afterPrepend.length)
  const serialized = JSON.stringify(afterPrepend)
  assert.equal(serialized.includes(recentMessageId), false)
  assert.equal(serialized.includes(olderMessageId), false)
})

function message(
  role: FlueConversationMessage['role'],
  purpose: FlueConversationMessage['purpose'],
  display: FlueConversationMessage['display'],
  parts: FlueConversationPart[],
  id?: string,
): FlueConversationMessage {
  const messageId = id ?? `${privateValues.identifier}-${messageSequence += 1}`
  return {
    id: messageId,
    role,
    purpose,
    display,
    submissionId: 'PRIVATE_SUBMISSION_IDENTIFIER',
    turnId: 'PRIVATE_TURN_IDENTIFIER',
    signal: { tagName: 'PRIVATE_SIGNAL', attributes: { value: 'PRIVATE_SIGNAL_ATTRIBUTE' } },
    parts,
    metadata: { value: privateValues.metadata },
  }
}

function timelineContent(timeline: ReturnType<typeof projectVisibleAgentTimeline>) {
  return timeline.map((item) => {
    assert.match(item.id, /^agent-timeline-[0-9a-f]{16}-\d+$/)
    const { id, ...content } = item
    assert.ok(id.length > 0)
    return content
  })
}

function lifecyclePart(
  operation: string,
  status: string,
  durationMs?: number,
): FlueConversationPart {
  return {
    type: 'data-autonomy-lifecycle',
    data: { operation, phase: 'reading', role: 'reader', status, ...(durationMs === undefined ? {} : { durationMs }) },
  }
}
