import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlueConversationMessage } from '@flue/sdk'

import {
  createIntelligenceHistoryAwareFetch,
  createIntelligenceStreamHeaderProvider,
  loadOlderIntelligenceHistory,
  mergeIntelligenceHistoryMessages,
  type IntelligenceHistoryPageState,
} from './intelligenceStream.ts'

test('coalesces concurrent stream access and refreshes expired tickets', async () => {
  const originalNow = Date.now
  let now = 10_000
  let calls = 0
  Date.now = () => now
  try {
    const provider = createIntelligenceStreamHeaderProvider(async () => {
      calls += 1
      return {
        conversationUrl: 'https://intelligence.example/v1/operations-copilot/conversations/copilot%3Aevent%3Acv',
        ticket: `ticket-${calls}`,
        issuedAt: now,
        expiresAt: now + 60_000,
        signature: `signature-${calls}`,
      }
    })

    const [first, second] = await Promise.all([provider.headers(), provider.headers()])
    assert.equal(calls, 1)
    assert.deepEqual(first, second)
    assert.equal(first['x-c2c-stream-ticket'], 'ticket-1')

    now += 56_000
    const refreshed = await provider.headers()
    assert.equal(calls, 2)
    assert.equal(refreshed['x-c2c-stream-ticket'], 'ticket-2')
  } finally {
    Date.now = originalNow
  }
})

test('rejects malformed stream access before exposing headers', async () => {
  const provider = createIntelligenceStreamHeaderProvider(async () => ({
    conversationUrl: 'not a URL',
    ticket: 'ticket',
    issuedAt: 1,
    expiresAt: 2,
    signature: 'signature',
  }))

  await assert.rejects(provider.headers(), /invalid access ticket/u)
})

test('loads an opaque older history page through the strict Flue snapshot contract', async () => {
  const originalFetch = globalThis.fetch
  const message = lifecycleMessage('message-older')
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
    assert.equal(url.searchParams.get('view'), 'history')
    assert.equal(url.searchParams.get('before'), 'opaque-before')
    return Response.json({
      v: 1,
      conversationId: 'autonomy-run',
      offset: '4_0',
      incarnation: 'incarnation-a',
      messages: [message],
      settlements: [],
    }, {
      headers: {
        'Intelligence-History-Before': 'opaque-next',
        'Intelligence-History-Has-Earlier': 'true',
      },
    })
  }
  try {
    const result = await loadOlderIntelligenceHistory({
      before: 'opaque-before',
      conversationUrl: 'https://intelligence.example/v1/operations-autonomy-runs/autonomy-run',
      headers: async () => ({ authorization: 'ticket' }),
    })
    assert.deepEqual(result.snapshot.messages, [message])
    assert.deepEqual(result.page, {
      before: 'opaque-next',
      hasEarlier: true,
      incarnation: 'incarnation-a',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('captures the head cursor and prepends older messages exactly once', async () => {
  const originalFetch = globalThis.fetch
  const captured: IntelligenceHistoryPageState[] = []
  globalThis.fetch = async () => Response.json({
    v: 1,
    conversationId: 'autonomy-run',
    offset: '8_0',
    messages: [lifecycleMessage('message-current')],
    settlements: [],
  }, {
    headers: {
      'Intelligence-History-Before': 'opaque-before',
      'Intelligence-History-Has-Earlier': 'true',
    },
  })
  try {
    const historyFetch = createIntelligenceHistoryAwareFetch((page) => captured.push(page))
    await historyFetch('https://intelligence.example/run?view=history')
    assert.deepEqual(captured, [{ before: 'opaque-before', hasEarlier: true }])
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(
    mergeIntelligenceHistoryMessages(
      [lifecycleMessage('message-older'), lifecycleMessage('message-overlap')],
      [lifecycleMessage('message-overlap'), lifecycleMessage('message-current')],
    ).map((message) => message.id),
    ['message-older', 'message-overlap', 'message-current'],
  )
})

function lifecycleMessage(id: string): FlueConversationMessage {
  return {
    id,
    role: 'assistant',
    purpose: 'assistant',
    display: 'visible',
    parts: [{
      type: 'data-autonomy-lifecycle',
      data: {
        operation: 'read_operations_data',
        status: 'completed',
        durationMs: 4,
      },
    }],
  }
}
