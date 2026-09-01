import type { FlueConversationMessage } from '@flue/react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Streamdown } from 'streamdown'

import {
  projectVisibleAgentTimeline,
  type SafeAgentTimelineItem,
} from './liveAgentProjection'
import { LoadingState, StatusText } from './LoadingState'
import { useVersionedState } from '@code2create/web-forms'

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
  embedded = false,
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
  timelineFooter,
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
  embedded?: boolean
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
  timelineFooter?: ReactNode
  workingCopy?: LiveAgentCopy
}) {
  const timeline = useMemo(
    () => projectVisibleAgentTimeline(messages, { showOperatorMessages }),
    [messages, showOperatorMessages],
  )
  const timelineRef = useRef<HTMLDivElement>(null)
  const historyAnchorRef = useRef<{ timelineId: string; viewportOffset: number } | null>(null)
  const stickToLiveTailRef = useRef(true)
  const promptId = useId()
  const promptHintId = useId()
  const composerState = useVersionedState(
    `${composerResetKey}`,
    { prompt: '', submitFailed: false },
  )
  const { prompt, submitFailed } = composerState.value
  const setPrompt = (prompt: string) => {
    composerState.update((current) => ({ ...current, prompt }))
  }
  const setSubmitFailed = (submitFailed: boolean) => {
    composerState.update((current) => ({ ...current, submitFailed }))
  }
  const [submitting, setSubmitting] = useState(false)

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
    <section
      aria-label={`${agentLabel} conversation`}
      className={embedded
        ? 'flex flex-col rounded-xl border border-line bg-canvas'
        : 'flex min-h-0 flex-1 flex-col'}
    >
      <div
        aria-busy={isStreaming}
        aria-live="polite"
        aria-relevant="additions text"
        className={embedded
          ? 'max-h-80 overflow-y-auto'
          : 'min-h-0 flex-1 overflow-y-auto'}
        onScroll={(event) => {
          stickToLiveTailRef.current = isNearLiveTail(event.currentTarget)
        }}
        ref={timelineRef}
        role="log"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-2.5 px-4 pt-4 pb-6">
          {onLoadOlder !== undefined && (historyCanLoadMore || historyLoading) ? (
            <div className="flex justify-center pb-1">
              {historyLoading ? (
                <StatusText>Loading earlier activity</StatusText>
              ) : (
                <button
                  className="cursor-pointer border-0 bg-transparent p-0 text-[11.5px] text-ink-3 transition-colors duration-100 hover:text-ink"
                  type="button"
                  onClick={loadOlderActivity}
                >
                  Load earlier activity
                </button>
              )}
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
          {timeline.map((item) => (
            <TimelineItem agentLabel={agentLabel} item={item} key={item.id} />
          ))}
          {isStreaming ? <StreamingIndicator copy={workingCopy} /> : null}
          {terminalState !== 'none'
            && !isStreaming
            && (terminalState !== 'completed' || terminalCopyOverrides?.completed !== undefined) ? (
            <TerminalState
              {...terminalCopyOverrides?.[terminalState] === undefined
                ? {}
                : { copy: terminalCopyOverrides[terminalState] }}
              state={terminalState}
            />
          ) : null}
          {timelineFooter === undefined ? null : (
            <div className="pt-3 pb-2">{timelineFooter}</div>
          )}
        </div>
      </div>

      {connectionState === 'offline' ? (
        <div className="flex shrink-0 items-center justify-center gap-2 py-1 text-[11.5px] text-ink-3" role="status">
          Updates paused
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-ink-2 underline-offset-2 transition-colors duration-100 hover:text-ink hover:underline"
            type="button"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        </div>
      ) : null}

      {onSubmitPrompt === undefined ? null : (
        <form
          className={embedded ? 'shrink-0 p-1.5 pb-3' : 'shrink-0 px-4 pt-2 pb-8'}
          onSubmit={(event) => void sendPrompt(event)}
        >
          <div className="mx-auto w-full max-w-3xl">
            <div className="flex cursor-text flex-col gap-2 rounded-[14px] border border-line bg-field p-2.5 transition-[border-color] duration-150 focus-within:border-line-strong">
              <label className="visually-hidden" htmlFor={promptId}>
                Ask the operations copilot
              </label>
              <textarea
                aria-describedby={promptHintId}
                className="field-sizing-content max-h-40 min-h-[22px] w-full resize-none border-0 bg-transparent p-0 px-0.5 text-[13px] leading-[1.4] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 focus-visible:outline-none disabled:opacity-50"
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
                rows={1}
                value={prompt}
              />
              <div className="flex items-center justify-between gap-2">
                <small
                  aria-live="polite"
                  className="text-[11px] text-ink-3"
                  id={promptHintId}
                >
                  {composerPendingConfirmation
                    ? 'Delivery was interrupted. Retry this same message; it cannot be sent twice.'
                    : 'Enter to send · Shift+Enter for a new line'}
                </small>
                <button
                  aria-label={submitting ? 'Sending' : composerPendingConfirmation ? 'Retry same message' : 'Send'}
                  className="flex size-7 shrink-0 items-center justify-center rounded-[8px] border-0 bg-ink text-canvas transition-[background-color,color,transform] duration-200 enabled:cursor-pointer enabled:active:scale-[0.96] disabled:bg-line-strong disabled:text-ink-2"
                  disabled={!canSubmit}
                  type="submit"
                >
                  {composerPendingConfirmation && !submitting ? (
                    <Glyph name="check" size={15} stroke={2.4} />
                  ) : (
                    <Glyph name="arrow-up" size={16} stroke={2.4} />
                  )}
                </button>
              </div>
            </div>
            {submitFailed && !composerPendingConfirmation ? (
              <p className="notice error" role="alert">
                The prompt was not sent. Your draft is still here; check the connection and try again.
              </p>
            ) : null}
          </div>
        </form>
      )}
    </section>
  )
}

function AgentEmptyState({ description, title }: { description: string; title: string }) {
  return (
    <div className="m-auto flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <Glyph className="text-ink-3" name="sparkle" size={20} />
      <strong className="text-[13px] font-medium text-ink">{title}</strong>
      <span className="max-w-90 text-[12.5px] leading-normal text-ink-3">{description}</span>
    </div>
  )
}

function TimelineItem({ agentLabel, item }: { agentLabel: string; item: SafeAgentTimelineItem }) {
  if (item.kind === 'operator-text') {
    return (
      <article className="flex justify-end pl-14" data-timeline-id={item.id}>
        <span className="visually-hidden">You said:</span>
        <p className="m-0 rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {item.text}
        </p>
      </article>
    )
  }

  if (item.kind === 'assistant-text') {
    return (
      <article className="w-full animate-fade-up" data-timeline-id={item.id}>
        <span className="visually-hidden">{agentLabel} said:</span>
        <Streamdown className="text-[13px] leading-normal text-ink">
          {item.text}
        </Streamdown>
      </article>
    )
  }

  if (item.kind === 'thinking') {
    return <ThinkingTrace id={item.id} state={item.state} text={item.text} />
  }

  return (
    <div
      className="flex h-7 w-full min-w-0 items-center gap-2 px-[3px]"
      data-timeline-id={item.id}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
        <ToolStateGlyph state={item.state} />
      </span>
      <span className="shrink-0 text-[12.5px] font-medium text-ink">{item.label}</span>
      {item.durationMs === undefined ? null : (
        <span className="inline-flex h-5.5 min-w-0 items-center truncate rounded-[6px] bg-field px-1.5 text-[11.5px] text-ink-2 tabular-nums">
          {formatDuration(item.durationMs)}
        </span>
      )}
      <span className="visually-hidden">{toolStateLabel(item.state)}</span>
    </div>
  )
}

function ThinkingTrace({
  id,
  state,
  text,
}: {
  id: string
  state: 'streaming' | 'done'
  text: string
}) {
  const [preference, setPreference] = useState({ state, open: state === 'streaming' })
  const open = preference.state === state ? preference.open : state === 'streaming'

  return (
    <div data-timeline-id={id}>
      <button
        aria-expanded={open}
        className="-mx-1.5 flex w-fit cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
        type="button"
        onClick={() => setPreference({ state, open: !open })}
      >
        <Glyph className="text-ink-3" name="sparkle" size={16} />
        <span className={state === 'streaming'
          ? undefined
          : 'text-[13px] font-medium whitespace-nowrap text-ink-2'}
        >
          {state === 'streaming'
            ? <StatusText>Thinking</StatusText>
            : 'Thought through the request'}
        </span>
        <Glyph
          className={`text-ink-3 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          name="chevron"
          size={14}
          stroke={2.2}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-400 ease-[cubic-bezier(0.23,1,0.32,1)] ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span aria-hidden className="absolute top-0 left-[3px] h-full w-px bg-line" />
            <p className="m-0 py-1 text-[12.5px] leading-[1.6] whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
              {text.length > 0 ? text : 'No reasoning text was recorded for this step.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function StreamingIndicator({ copy }: { copy: LiveAgentCopy }) {
  return (
    <div className="px-[3px] py-1" role="status">
      <LoadingState label={copy.title} />
      <span className="visually-hidden">{copy.detail}</span>
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
    <div
      className="flex items-center gap-2 py-1"
      role={state === 'failed' ? 'alert' : 'status'}
    >
      <span className={`inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-medium ${terminalTone(state)}`}>
        {terminalLabel(state)}
      </span>
      <span className="text-[11.5px] text-ink-3">{copy.detail}</span>
    </div>
  )
}

function ToolStateGlyph({
  state,
}: {
  state: Extract<SafeAgentTimelineItem, { kind: 'tool' }>['state']
}) {
  if (state === 'running') return <Spinner />
  if (state === 'failed') return <Glyph className="text-red" name="alert" size={14} stroke={2.2} />
  return <Glyph name="check" size={14} stroke={2.5} />
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink-2"
    />
  )
}

const glyphPaths = {
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  check: 'M20 6L9 17l-5-5',
  chevron: 'M6 9l6 6 6-6',
  alert: 'M12 8.5v5M12 17h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  sparkle: 'M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z',
} as const

function Glyph({
  className,
  name,
  size,
  stroke,
}: {
  className?: string
  name: keyof typeof glyphPaths
  size: number
  stroke?: number
}) {
  const filled = stroke === undefined
  return (
    <svg
      aria-hidden
      {...className === undefined ? {} : { className }}
      fill={filled ? 'currentColor' : 'none'}
      height={size}
      {...filled
        ? {}
        : {
            stroke: 'currentColor',
            strokeLinecap: 'round' as const,
            strokeLinejoin: 'round' as const,
            strokeWidth: stroke,
          }}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={glyphPaths[name]} />
    </svg>
  )
}

function toolStateLabel(state: Extract<SafeAgentTimelineItem, { kind: 'tool' }>['state']) {
  if (state === 'running') return 'Running'
  if (state === 'complete') return 'Done'
  return 'Stopped'
}

function terminalLabel(state: Exclude<LiveAgentTerminalState, 'none'>) {
  if (state === 'completed') return 'Completed'
  if (state === 'aborted') return 'Stopped'
  return 'Failed'
}

function terminalTone(state: Exclude<LiveAgentTerminalState, 'none'>) {
  if (state === 'completed') return 'bg-green/10 text-green'
  if (state === 'aborted') return 'bg-amber/10 text-amber'
  return 'bg-red/10 text-red'
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
