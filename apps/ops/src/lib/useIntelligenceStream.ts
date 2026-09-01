import { useFlueAgent } from '@flue/react'
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OperationsIntelligenceStreamAccess } from '@code2create/domain'

import {
  createIntelligenceHistoryAwareFetch,
  createIntelligenceStreamHeaderProvider,
  loadOlderIntelligenceHistory,
  mergeIntelligenceHistoryMessages,
  type IntelligenceHistoryPageState,
} from './intelligenceStream'

type HistoryState = IntelligenceHistoryPageState & {
  error?: Error
  key: string
  loading: boolean
  messages: FlueConversationMessage[]
  olderPagesLoaded: boolean
}

function emptyHistoryState(key: string): HistoryState {
  return { hasEarlier: false, key, loading: false, messages: [], olderPagesLoaded: false }
}

export function useIntelligenceStream(args: {
  enabled: boolean
  loadAccess: () => Promise<OperationsIntelligenceStreamAccess>
  streamKey: string
}) {
  const providerState = useMemo(() => ({
    key: args.streamKey,
    provider: createIntelligenceStreamHeaderProvider(args.loadAccess),
  }), [args.loadAccess, args.streamKey])
  const provider = providerState.provider
  const streamKey = providerState.key
  const [accessState, setAccessState] = useState<{
    error?: Error
    key: string
    url?: string
  }>(() => ({ key: args.streamKey }))
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [historyState, setHistoryState] = useState<HistoryState>(() =>
    emptyHistoryState(args.streamKey),
  )
  const conversationUrl = args.enabled && accessState.key === streamKey
    ? accessState.url
    : undefined
  const accessError = args.enabled && accessState.key === streamKey
    ? accessState.error
    : undefined

  useEffect(() => {
    if (!args.enabled) {
      provider.invalidate()
      return
    }
    let active = true
    void provider.conversationUrl().then((url) => {
      if (!active) return
      setAccessState({ key: streamKey, url })
    }).catch((caught: unknown) => {
      if (!active) return
      setAccessState({ key: streamKey, error: errorFrom(caught) })
    })
    return () => {
      active = false
    }
  }, [args.enabled, connectionAttempt, provider, streamKey])

  const historyFetch = useMemo(
    () => createIntelligenceHistoryAwareFetch((page) => {
      setHistoryState((current) => {
        const sameStream = current.key === streamKey
        const incarnationChanged =
          sameStream
          && current.incarnation !== undefined
          && page.incarnation !== undefined
          && current.incarnation !== page.incarnation
        if (sameStream && !incarnationChanged && current.olderPagesLoaded) {
          return {
            ...current,
            ...(page.incarnation === undefined ? {} : { incarnation: page.incarnation }),
          }
        }
        return {
          ...emptyHistoryState(streamKey),
          ...page,
          messages: sameStream && !incarnationChanged ? current.messages : [],
        }
      })
    }),
    [streamKey],
  )

  const client = useMemo(
    () => conversationUrl
      ? createFlueClient({
          url: conversationUrl,
          headers: provider.headers,
          fetch: historyFetch,
        })
      : undefined,
    [conversationUrl, historyFetch, provider],
  )
  const agent = useFlueAgent(client ? { client, live: 'long-poll' } : undefined)
  const loadOlder = useCallback(async () => {
    const current = historyState.key === streamKey ? historyState : emptyHistoryState(streamKey)
    if (!current.hasEarlier || current.before === undefined || current.loading) return
    setHistoryState((value) => {
      if (value.key !== streamKey) return value
      const { error: _error, ...withoutError } = value
      return { ...withoutError, loading: true }
    })
    try {
      const url = conversationUrl ?? await provider.conversationUrl()
      const older = await loadOlderIntelligenceHistory({
        before: current.before,
        conversationUrl: url,
        headers: provider.headers,
      })
      setHistoryState((value) => {
        if (value.key !== streamKey) return value
        if (
          value.incarnation !== undefined
          && older.snapshot.incarnation !== undefined
          && value.incarnation !== older.snapshot.incarnation
        ) {
          return {
            ...emptyHistoryState(streamKey),
            error: new Error('The intelligence history changed while older activity was loading.'),
          }
        }
        return {
          ...value,
          ...older.page,
          loading: false,
          messages: mergeIntelligenceHistoryMessages(older.snapshot.messages, value.messages),
          olderPagesLoaded: true,
        }
      })
    } catch (caught: unknown) {
      provider.invalidate()
      setHistoryState((value) => value.key === streamKey
        ? { ...value, error: errorFrom(caught), loading: false }
        : value)
    }
  }, [conversationUrl, historyState, provider, streamKey])
  const messages = useMemo(
    () => mergeIntelligenceHistoryMessages(
      historyState.key === streamKey ? historyState.messages : [],
      agent.messages,
    ),
    [agent.messages, historyState, streamKey],
  )
  const reconnect = useCallback(() => {
    provider.invalidate()
    setHistoryState(emptyHistoryState(streamKey))
    if (conversationUrl) {
      agent.refresh()
      return
    }
    setAccessState({ key: streamKey })
    setConnectionAttempt((attempt) => attempt + 1)
  }, [agent, conversationUrl, provider, streamKey])

  return {
    ...agent,
    accessError,
    historyCanLoadMore: args.enabled && historyState.key === streamKey && historyState.hasEarlier,
    historyLoadError: args.enabled && historyState.key === streamKey
      ? historyState.error
      : undefined,
    historyLoading: args.enabled && historyState.key === streamKey && historyState.loading,
    loadOlder,
    messages: args.enabled ? messages : [],
    reconnect,
  }
}

function errorFrom(caught: unknown) {
  return caught instanceof Error ? caught : new Error('The intelligence stream is unavailable.')
}
