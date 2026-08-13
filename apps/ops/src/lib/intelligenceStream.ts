import {
  operationsIntelligenceStreamTicketHeaders,
  type OperationsIntelligenceStreamAccess,
} from '@code2create/domain'
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk'

type HeaderLoader = () => Promise<OperationsIntelligenceStreamAccess>

const refreshBeforeExpiryMs = 5_000
const historyBeforeHeader = 'Intelligence-History-Before'
const historyHasEarlierHeader = 'Intelligence-History-Has-Earlier'

export type IntelligenceHistoryPageState = {
  before?: string
  hasEarlier: boolean
  incarnation?: string
}

export function createIntelligenceStreamHeaderProvider(load: HeaderLoader) {
  let cached: OperationsIntelligenceStreamAccess | undefined
  let pending: Promise<OperationsIntelligenceStreamAccess> | undefined

  const current = async () => {
    if (cached && cached.expiresAt - Date.now() > refreshBeforeExpiryMs) return cached
    pending ??= load().then((access) => {
      assertStreamAccess(access)
      cached = access
      return access
    }).finally(() => {
      pending = undefined
    })
    return pending
  }

  return {
    async headers() {
      const access = await current()
      return {
        [operationsIntelligenceStreamTicketHeaders.ticket]: access.ticket,
        [operationsIntelligenceStreamTicketHeaders.timestamp]: access.issuedAt.toString(),
        [operationsIntelligenceStreamTicketHeaders.signature]: access.signature,
      }
    },
    async conversationUrl() {
      return (await current()).conversationUrl
    },
    invalidate() {
      cached = undefined
    },
  }
}

export function createIntelligenceHistoryAwareFetch(
  onHistoryPage: (page: IntelligenceHistoryPageState) => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    if (response.ok && requestIsHistory(input)) {
      const page = await intelligenceHistoryPageState(response)
      if (page !== null) onHistoryPage(page)
    }
    return response
  }
}

export async function loadOlderIntelligenceHistory(args: {
  before: string
  conversationUrl: string
  headers: () => Promise<Record<string, string>>
}) {
  const captured: { page?: IntelligenceHistoryPageState } = {}
  const client = createFlueClient({
    url: args.conversationUrl,
    headers: args.headers,
    fetch: async (input, init) => {
      const url = requestUrl(input)
      url.searchParams.set('before', args.before)
      const response = await fetch(url, init)
      if (response.ok) {
        const page = await intelligenceHistoryPageState(response)
        if (page !== null) captured.page = page
      }
      return response
    },
  })
  const snapshot = await client.history()
  if (captured.page === undefined) {
    throw new Error('The intelligence history page did not include valid pagination metadata.')
  }
  return { snapshot, page: captured.page }
}

export function mergeIntelligenceHistoryMessages(
  older: readonly FlueConversationMessage[],
  current: readonly FlueConversationMessage[],
) {
  const messages = new Map<string, FlueConversationMessage>()
  for (const message of [...older, ...current]) messages.set(message.id, message)
  return [...messages.values()]
}

async function intelligenceHistoryPageState(
  response: Response,
): Promise<IntelligenceHistoryPageState | null> {
  const hasEarlierText = response.headers.get(historyHasEarlierHeader)
  if (hasEarlierText !== 'true' && hasEarlierText !== 'false') return null
  const hasEarlier = hasEarlierText === 'true'
  const before = response.headers.get(historyBeforeHeader) ?? undefined
  if (hasEarlier !== (before !== undefined)) return null
  const value: unknown = await response.clone().json()
  const incarnation = snapshotIncarnation(value)
  return {
    ...(before === undefined ? {} : { before }),
    hasEarlier,
    ...(incarnation === undefined ? {} : { incarnation }),
  }
}

function snapshotIncarnation(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (!('incarnation' in value) || value.incarnation === undefined) return undefined
  return typeof value.incarnation === 'string' ? value.incarnation : undefined
}

function requestIsHistory(input: RequestInfo | URL) {
  return requestUrl(input).searchParams.get('view') === 'history'
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return new URL(input)
  if (typeof input === 'string') {
    return new URL(input, globalThis.location?.origin ?? 'http://localhost')
  }
  return new URL(input.url)
}

function assertStreamAccess(access: OperationsIntelligenceStreamAccess) {
  if (
    !URL.canParse(access.conversationUrl)
    || access.ticket.length === 0
    || access.signature.length === 0
    || !Number.isSafeInteger(access.issuedAt)
    || !Number.isSafeInteger(access.expiresAt)
    || access.expiresAt <= access.issuedAt
  ) {
    throw new Error('The intelligence stream returned an invalid access ticket.')
  }
}
