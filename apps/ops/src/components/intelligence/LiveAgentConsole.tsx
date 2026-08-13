import type { FlueConversationMessage } from '@flue/react'
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  projectVisibleAgentTimeline,
  type SafeAgentTimelineItem,
} from './liveAgentProjection'
import { Icon, type IconName } from '../Icon'

export type LiveAgentConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline'
export type LiveAgentTerminalState = 'none' | 'completed' | 'failed' | 'aborted'
type LiveAgentCopy = Readonly<{ title: string; detail: string }>

export function LiveAgentConsole({
  agentLabel = 'Copilot',
  composerPendingConfirmation = false,
  composerRequiresConnection = true,
  composerResetKey = 0,
  composerDisabled = false,
  connectionState,
  connectionLabel,
  emptyDescription = 'Ask about review flow, attendance, floor mapping, support load, or admissions.',
  emptyTitle = 'Start with the live event.',
  historyCanLoadMore = false,
  historyLoadError,
  historyLoading = false,
  isStreaming,
  messages,
  onLoadOlder,
  onReconnect,
  onSubmitPrompt,
  showOperatorMessages = true,
  terminalState,
  terminalCopy: terminalCopyOverrides,
  title = 'Operations copilot',
  workingCopy = {
    title: 'Preparing response',
    detail: 'Live output continues here.',
  },
}: {
  agentLabel?: string
  composerPendingConfirmation?: boolean
  composerRequiresConnection?: boolean
  composerResetKey?: number
  composerDisabled?: boolean
  connectionState: LiveAgentConnectionState
  connectionLabel?: string
  emptyDescription?: string
  emptyTitle?: string
  historyCanLoadMore?: boolean
  historyLoadError?: Error
  historyLoading?: boolean
  isStreaming: boolean
  messages: readonly FlueConversationMessage[]
  onLoadOlder?: () => void | Promise<void>
  onReconnect: () => void
  onSubmitPrompt?: (prompt: string) => void | Promise<void>
  showOperatorMessages?: boolean
  terminalState: LiveAgentTerminalState
  terminalCopy?: Partial<Record<Exclude<LiveAgentTerminalState, 'none'>, LiveAgentCopy>>
  title?: string
  workingCopy?: LiveAgentCopy
}) {
  const timeline = useMemo(
    () => projectVisibleAgentTimeline(messages, { showOperatorMessages }),
    [messages, showOperatorMessages],
  )
  const timelineRef = useRef<HTMLDivElement>(null)
  const historyAnchorRef = useRef<{ timelineId: string; viewportOffset: number } | null>(null)
  const stickToLiveTailRef = useRef(true)
  const titleId = useId()
  const promptId = useId()
  const promptHintId = useId()
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitFailed, setSubmitFailed] = useState(false)

  useEffect(() => {
    setPrompt('')
    setSubmitFailed(false)
  }, [composerResetKey])

  useLayoutEffect(() => {
    const timelineElement = timelineRef.current
    if (timelineElement === null) return

    const historyAnchor = historyAnchorRef.current
    if (historyAnchor !== null) {
      const anchorElement = timelineItemElement(timelineElement, historyAnchor.timelineId)
      if (anchorElement !== undefined) {
        const currentOffset = anchorElement.getBoundingClientRect().top
          - timelineElement.getBoundingClientRect().top
        timelineElement.scrollTop += currentOffset - historyAnchor.viewportOffset
      }
      if (!historyLoading) historyAnchorRef.current = null
    } else if (historyAnchor === null && stickToLiveTailRef.current) {
      timelineElement.scrollTop = timelineElement.scrollHeight
    }

    stickToLiveTailRef.current = isNearLiveTail(timelineElement)
  }, [historyLoading, isStreaming, timeline])

  const loadOlderActivity = () => {
    const timelineElement = timelineRef.current
    if (timelineElement !== null) {
      historyAnchorRef.current = visibleTimelineAnchor(timelineElement)
    }
    void onLoadOlder?.()
  }

  const sendPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextPrompt = prompt.trim()
    if (
      nextPrompt.length === 0
      || onSubmitPrompt === undefined
      || submitting
      || composerDisabled
      || (composerRequiresConnection && connectionState !== 'connected')
      || isStreaming
    ) {
      return
    }

    setSubmitting(true)
    setSubmitFailed(false)
    try {
      await onSubmitPrompt(nextPrompt)
      setPrompt('')
    } catch {
      setSubmitFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  const canSubmit =
    prompt.trim().length > 0
    && !submitting
    && !composerDisabled
    && !isStreaming
    && onSubmitPrompt !== undefined
    && (!composerRequiresConnection || connectionState === 'connected')

  return (
    <section className="card-surface intelligence-console" aria-labelledby={titleId}>
      <header className="section-heading intelligence-console-header">
        <div>
          <p className="eyebrow">Live agent</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <ConnectionStatus
          {...connectionLabel === undefined ? {} : { label: connectionLabel }}
          state={connectionState}
          onReconnect={onReconnect}
        />
      </header>

      <div
        aria-busy={isStreaming}
        aria-live="polite"
        aria-relevant="additions text"
        className="health-list intelligence-console-timeline"
        onScroll={(event) => {
          stickToLiveTailRef.current = isNearLiveTail(event.currentTarget)
        }}
        ref={timelineRef}
        role="log"
      >
        {onLoadOlder !== undefined && (historyCanLoadMore || historyLoading) ? (
          <div className="list-row">
            <div className="row-text">
              <strong>Earlier agent activity</strong>
              <small>History pages remain sanitized and read-only.</small>
            </div>
            <button
              className="secondary"
              disabled={historyLoading}
              type="button"
              onClick={loadOlderActivity}
            >
              {historyLoading ? 'Loading activity…' : 'Load older activity'}
            </button>
          </div>
        ) : null}
        {historyLoadError === undefined ? null : (
          <p className="notice error" role="alert">
            Older activity could not be loaded. Try again.
          </p>
        )}
        {timeline.length === 0 && !isStreaming ? (
          <AgentEmptyState description={emptyDescription} title={emptyTitle} />
        ) : null}
        {timeline.map((item) => <TimelineItem agentLabel={agentLabel} item={item} key={item.id} />)}
        {isStreaming ? <StreamingIndicator copy={workingCopy} /> : null}
        {terminalState !== 'none' && !isStreaming ? (
          <TerminalState
            {...terminalCopyOverrides?.[terminalState] === undefined
              ? {}
              : { copy: terminalCopyOverrides[terminalState] }}
            state={terminalState}
          />
        ) : null}
      </div>

      {onSubmitPrompt === undefined ? null : (
        <form className="intelligence-console-composer" onSubmit={(event) => void sendPrompt(event)}>
          <label className="field" htmlFor={promptId}>
            <span className="visually-hidden">Ask the operations copilot</span>
            <textarea
              aria-describedby={promptHintId}
              disabled={composerDisabled || submitting}
              id={promptId}
              maxLength={4_000}
              onChange={(event) => {
                setPrompt(event.target.value)
                if (submitFailed) setSubmitFailed(false)
              }}
              onKeyDown={submitOnEnter}
              placeholder="Ask what needs attention…"
              readOnly={composerPendingConfirmation}
              rows={2}
              value={prompt}
            />
            <small id={promptHintId}>
              {composerPendingConfirmation
                ? 'The previous send may have committed. Confirm it before starting another prompt.'
                : `Enter to send · Shift+Enter for a new line · ${prompt.length}/4000`}
            </small>
          </label>
          <div className="button-row">
            <button className="primary" disabled={!canSubmit} type="submit">
              {submitting ? 'Sending…' : composerPendingConfirmation ? 'Confirm send' : 'Send'}
            </button>
          </div>
          {submitFailed ? (
            <p className="notice error" role="alert">
              The prompt was not sent. Your draft is still here; check the connection and try again.
            </p>
          ) : null}
        </form>
      )}
    </section>
  )
}

function ConnectionStatus({
  label,
  onReconnect,
  state,
}: {
  label?: string
  onReconnect: () => void
  state: LiveAgentConnectionState
}) {
  const visibleLabel = label ?? connectionLabel(state)
  return (
    <div className="row-controls intelligence-console-connection" role="status">
      <span className={`state-label ${state}`}>{visibleLabel}</span>
      {state === 'offline' ? (
        <button className="row-action" type="button" onClick={onReconnect}>Reconnect</button>
      ) : null}
    </div>
  )
}

function AgentEmptyState({ description, title }: { description: string; title: string }) {
  return (
    <div className="health-empty intelligence-console-empty">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  )
}

function TimelineItem({ agentLabel, item }: { agentLabel: string; item: SafeAgentTimelineItem }) {
  if (item.kind === 'operator-text') {
    return (
      <article className="list-row intelligence-console-row operator" data-timeline-id={item.id}>
        <span className="visually-hidden">You said:</span>
        <span className="row-glyph"><Icon name="users" /></span>
        <div className="row-text">
          <strong>You</strong>
          <small>{item.text}</small>
        </div>
      </article>
    )
  }

  if (item.kind === 'assistant-text') {
    return (
      <article className={`list-row intelligence-console-row ${item.state}`} data-timeline-id={item.id}>
        <span className="row-glyph watch"><Icon name="pulse" /></span>
        <div className="row-text">
          <strong>{agentLabel}</strong>
          <small>{item.text}</small>
        </div>
        {item.state === 'streaming' ? <span className="state-label">Writing</span> : null}
      </article>
    )
  }

  if (item.kind === 'thinking') return <ThinkingLifecycle id={item.id} state={item.state} />

  return (
    <div className={`list-row intelligence-console-row ${item.state}`} data-timeline-id={item.id}>
      <span className={`row-glyph ${toolTone(item.state)}`}>
        <Icon name={toolIcon(item.state)} />
      </span>
      <div className="row-text">
        <strong>{item.label}</strong>
        {item.durationMs === undefined ? null : <small>{formatDuration(item.durationMs)}</small>}
      </div>
      <span className="state-label">{toolStateLabel(item.state)}</span>
    </div>
  )
}

function ThinkingLifecycle({ id, state }: { id: string; state: 'streaming' | 'done' }) {
  const [open, setOpen] = useState(state === 'streaming')

  useEffect(() => {
    setOpen(state === 'streaming')
  }, [state])

  return (
    <details
      className={`intelligence-console-thinking ${state}`}
      data-timeline-id={id}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="list-row">
        <span className={`row-glyph ${state === 'streaming' ? 'attention' : 'watch'}`}>
          <Icon name="pulse" />
        </span>
        <span className="row-text">
          <strong>{state === 'streaming' ? 'Thinking' : 'Thought through the request'}</strong>
          <small>Internal reasoning stays private.</small>
        </span>
        <span className="state-label">{state === 'streaming' ? 'Working' : 'Done'}</span>
      </summary>
      <p className="muted">This entry shows only the reasoning lifecycle.</p>
    </details>
  )
}

function StreamingIndicator({ copy }: { copy: LiveAgentCopy }) {
  return (
    <div className="list-row intelligence-console-row" role="status">
      <span className="row-glyph attention"><Icon name="pulse" /></span>
      <div className="row-text">
        <strong>{copy.title}</strong>
        <small>{copy.detail}</small>
      </div>
      <span className="state-label">Working</span>
    </div>
  )
}

function TerminalState({
  copy: copyOverride,
  state,
}: {
  copy?: LiveAgentCopy
  state: Exclude<LiveAgentTerminalState, 'none'>
}) {
  const copy = copyOverride ?? terminalCopy(state)
  return (
    <div className={`list-row intelligence-console-row ${state}`} role={state === 'failed' ? 'alert' : 'status'}>
      <span className={`row-glyph ${terminalTone(state)}`}>
        <Icon name={terminalIcon(state)} />
      </span>
      <div className="row-text">
        <strong>{copy.title}</strong>
        <small>{copy.detail}</small>
      </div>
    </div>
  )
}

function connectionLabel(state: LiveAgentConnectionState) {
  if (state === 'connecting') return 'Connecting'
  if (state === 'connected') return 'Live'
  if (state === 'reconnecting') return 'Reconnecting'
  return 'Updates paused'
}

function toolStateLabel(state: Extract<SafeAgentTimelineItem, { kind: 'tool' }>['state']) {
  if (state === 'running') return 'Running'
  if (state === 'complete') return 'Done'
  return 'Stopped'
}

function toolIcon(
  state: Extract<SafeAgentTimelineItem, { kind: 'tool' }>['state'],
): IconName {
  if (state === 'complete') return 'check'
  if (state === 'failed') return 'alert'
  return 'code'
}

function toolTone(state: Extract<SafeAgentTimelineItem, { kind: 'tool' }>['state']) {
  if (state === 'failed') return 'critical'
  if (state === 'running') return 'attention'
  return 'watch'
}

function terminalIcon(state: Exclude<LiveAgentTerminalState, 'none'>): IconName {
  if (state === 'completed') return 'check'
  if (state === 'failed') return 'alert'
  return 'pause'
}

function terminalTone(state: Exclude<LiveAgentTerminalState, 'none'>) {
  if (state === 'failed') return 'critical'
  if (state === 'aborted') return 'attention'
  return 'watch'
}

function terminalCopy(state: Exclude<LiveAgentTerminalState, 'none'>) {
  if (state === 'completed') {
    return { title: 'Response complete', detail: 'The copilot is ready for the next question.' }
  }
  if (state === 'aborted') {
    return { title: 'Turn stopped', detail: 'No further work is running for this turn.' }
  }
  return {
    title: 'Turn did not finish',
    detail: 'Try the prompt again when the copilot is ready.',
  }
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return '<1s'
  const durationSeconds = Math.round(durationMs / 1_000)
  if (durationSeconds < 60) return `${durationSeconds}s`
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

function isNearLiveTail(element: HTMLDivElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48
}

function visibleTimelineAnchor(element: HTMLDivElement) {
  const containerTop = element.getBoundingClientRect().top
  for (const item of element.querySelectorAll<HTMLElement>('[data-timeline-id]')) {
    const viewportOffset = item.getBoundingClientRect().top - containerTop
    if (viewportOffset + item.offsetHeight < 0) continue
    const timelineId = item.dataset['timelineId']
    if (timelineId !== undefined) return { timelineId, viewportOffset }
  }
  return null
}

function timelineItemElement(element: HTMLDivElement, timelineId: string) {
  for (const item of element.querySelectorAll<HTMLElement>('[data-timeline-id]')) {
    if (item.dataset['timelineId'] === timelineId) return item
  }
  return undefined
}
