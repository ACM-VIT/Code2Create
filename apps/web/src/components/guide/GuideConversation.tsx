import { api } from '@code2create/backend/api'
import type { SupportCaseState } from '@code2create/domain'
import { useUIMessages, type UIMessage } from '@convex-dev/agent/react'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { eventSlug } from '../../lib/config'
import { readableError } from '../../lib/errors'
import { BringTeamTool, GuideComposer } from './GuideComposer'
import { LoadingLine } from './GuideLoader'
import { GuideReasoning, type GuideStep } from './GuideReasoning'
import { GuideStage } from './GuideStage'
import {
  GuideChip,
  GuideHeader,
  GuideHero,
  GuideNotice,
  GuideTurn,
  LinkChip,
  SystemLine,
  TeamTurn,
  ThinkingTurn,
  UserTurn,
} from './GuideTurns'

type Conversation = FunctionReturnType<typeof api.participantAssistant.openConversation>
type Message = UIMessage

const escalationPrompt = 'Please bring someone from the event team into this conversation.'

function momentName(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function clockName(value: number) {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function teamStateName(state: SupportCaseState) {
  switch (state) {
    case 'open':
      return 'someone will pick this up'
    case 'investigating':
      return 'looking into it'
    case 'waiting':
      return 'waiting on you'
    case 'resolved':
      return 'marked resolved'
    case 'closed':
      return 'closed'
  }
}

/** The model's own summary of its thinking, as the agent streams and stores it. */
function reasoningOf(message: Message) {
  return message.parts.flatMap((part) => (part.type === 'reasoning' ? [part.text] : [])).join('\n\n')
}

function stepLabel(tool: string, state: GuideStep['state']) {
  if (tool === 'bringInEventTeam') {
    return state === 'done'
      ? 'Brought the event team into this conversation'
      : state === 'failed'
        ? 'Could not reach the event team'
        : 'Bringing in the event team'
  }
  const name = tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return state === 'done' ? `Finished: ${name}` : state === 'failed' ? `Failed: ${name}` : `Working: ${name}`
}

/** The tools the Guide called for this answer, as steps in the order it took them. */
function stepsOf(message: Message): GuideStep[] {
  return message.parts.flatMap((part) => {
    if (!('toolCallId' in part) || !('state' in part)) return []
    const tool = part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, '')
    const state: GuideStep['state'] =
      part.state === 'output-available' ? 'done' : part.state === 'output-error' ? 'failed' : 'running'
    return [{ key: part.toolCallId, label: stepLabel(tool, state), state }]
  })
}

/**
 * Help, as one conversation. Opening the Guide creates or resumes the
 * participant's thread; everything after that is the live thread.
 */
export function GuideConversation() {
  const openConversation = useMutation(api.participantAssistant.openConversation)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void openConversation({ eventSlug })
      .then((result) => {
        if (mounted) setConversation(result)
      })
      .catch((caught: unknown) => {
        if (mounted) setError(readableError(caught))
      })
    return () => {
      mounted = false
    }
  }, [openConversation])

  if (error !== null) {
    return (
      <div className="flex h-full w-full max-w-[760px] items-center justify-center">
        <GuideNotice message={`The Guide couldn’t open. ${error}`}>
          <span className="text-[12px] text-fg/55">
            Refresh to try again, or ask an organizer at the event desk.
          </span>
        </GuideNotice>
      </div>
    )
  }
  if (conversation === null) {
    return (
      <div className="flex h-full w-full max-w-[760px] items-center justify-center">
        <LoadingLine label="Getting your Guide ready" />
      </div>
    )
  }
  return <GuideThread conversation={conversation} />
}

function GuideThread({ conversation }: { conversation: Conversation }) {
  const sendMessage = useMutation(api.participantAssistant.sendMessage)
  const liveState = useQuery(api.participantAssistant.conversationState, {
    eventSlug,
    threadId: conversation.threadId,
  })
  const { results: messages, status: messageStatus, loadMore } = useUIMessages(
    api.participantAssistant.listMessages,
    { eventSlug, threadId: conversation.threadId },
    { initialNumItems: 40, stream: true },
  )
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [escalating, setEscalating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const wasAnsweringRef = useRef(false)

  const state = liveState ?? conversation
  const latestRequest = state.latestRequest
  const humanSupport = state.humanSupport
  const isAnswering = latestRequest?.state === 'scheduled' || latestRequest?.state === 'running'
  const disabled = sending || isAnswering

  const spoken = messages.filter((message) => message.role !== 'system' && message.text.trim().length > 0)
  const lastMessage = messages.at(-1)
  // Once the answer has started arriving, the thread shows it in place; until
  // then the Guide is only thinking, and the loading line stands in.
  const answerStarted = lastMessage?.role === 'assistant' && lastMessage.status === 'streaming'
  const showThinking = isAnswering && !answerStarted
  const asked = new Set(spoken.filter((message) => message.role === 'user').map((message) => message.text.trim()))
  const followUps = state.suggestions.filter((suggestion) => !asked.has(suggestion))
  const lastGuideKey = [...spoken].reverse().find((message) => message.role === 'assistant')?.key ?? null
  const lastUserText = [...spoken].reverse().find((message) => message.role === 'user')?.text ?? null
  const streamingMessage = lastMessage?.role === 'assistant' && lastMessage.status === 'streaming' ? lastMessage : null

  const visible = streamingMessage !== null && !spoken.includes(streamingMessage)
    ? [...spoken, streamingMessage]
    : spoken
  const timeline = [
    ...visible.map((message) => ({ kind: 'guide' as const, at: message._creationTime, message })),
    ...(humanSupport
      ? [
          { kind: 'joined' as const, at: humanSupport.joinedAt },
          ...humanSupport.messages.map((message) => ({ kind: 'team' as const, at: message.createdAt, message })),
        ]
      : []),
  ].sort((left, right) => left.at - right.at)

  useEffect(() => {
    if (wasAnsweringRef.current && !isAnswering) textareaRef.current?.focus()
    wasAnsweringRef.current = isAnswering
  }, [isAnswering])

  const ask = async (value: string) => {
    const message = value.trim()
    if (message.length < 2 || busyRef.current || isAnswering) return
    busyRef.current = true
    setSending(true)
    setError(null)
    try {
      await sendMessage({
        eventSlug,
        threadId: conversation.threadId,
        message,
        clientRequestId: crypto.randomUUID(),
      })
      setQuestion('')
      setEscalating(false)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setSending(false)
    }
  }

  /** How long the reader waited for this answer: from their message to the first of the Guide's. */
  const thoughtFor = (message: Message) => {
    const index = visible.indexOf(message)
    const prompt = [...visible.slice(0, index)].reverse().find((candidate) => candidate.role === 'user')
    return prompt === undefined ? undefined : Math.max(0, message._creationTime - prompt._creationTime)
  }

  const teamLine = humanSupport ? `event team ${teamStateName(humanSupport.state)}` : undefined

  return (
    <GuideStage
      header={
        <GuideHeader
          phaseLabel={state.phase.label}
          deadline={state.phase.deadline === undefined ? undefined : momentName(state.phase.deadline)}
          team={teamLine}
        />
      }
      composer={
        <GuideComposer
          value={question}
          onChange={setQuestion}
          onSend={() => void ask(question)}
          disabled={disabled}
          answering={isAnswering}
          textareaRef={textareaRef}
          {...(humanSupport === null
            ? { leading: <BringTeamTool disabled={disabled || escalating} onClick={() => setEscalating(true)} /> }
            : {})}
          {...(escalating
            ? {
                confirm: {
                  question: 'Bring the event team into this thread?',
                  confirmLabel: 'Bring them in',
                  busy: sending,
                  onConfirm: () => void ask(escalationPrompt),
                  onCancel: () => setEscalating(false),
                },
              }
            : {})}
        />
      }
    >
      {timeline.length === 0 && !showThinking ? (
        <div className="flex min-h-full flex-1 items-center py-6">
          <GuideHero
            description={state.phase.description}
            suggestions={state.suggestions}
            disabled={disabled}
            onPick={(suggestion) => void ask(suggestion)}
          />
        </div>
      ) : null}

      {messageStatus === 'CanLoadMore' ? (
        <div className="flex justify-center">
          <GuideChip onClick={() => loadMore(40)}>Show earlier messages</GuideChip>
        </div>
      ) : messageStatus === 'LoadingMore' ? (
        <div className="flex justify-center">
          <LoadingLine label="Loading earlier messages" />
        </div>
      ) : null}

      {timeline.map((entry) => {
        if (entry.kind === 'joined') {
          return <SystemLine key="joined">the event team joined · {clockName(entry.at)}</SystemLine>
        }
        if (entry.kind === 'team') {
          return <TeamTurn key={entry.message.id} body={entry.message.body} />
        }
        const message = entry.message
        if (message.role !== 'assistant') return <UserTurn key={message.key} text={message.text} />
        const streaming = message.status === 'streaming'
        const thinking = streaming && message.text.trim().length === 0
        const reasoning = reasoningOf(message)
        const steps = stepsOf(message)
        const latest = message.key === lastGuideKey
        const showLinks = latest && !streaming && state.officialLinks.length > 0
        const showFollowUps = latest && !streaming && !isAnswering && followUps.length > 0
        return (
          <GuideTurn
            key={message.key}
            text={message.text}
            streaming={streaming}
            officialLinks={state.officialLinks}
            {...(thinking || reasoning.length > 0 || steps.length > 0
              ? {
                  thinking: (
                    <GuideReasoning
                      reasoning={reasoning}
                      steps={steps}
                      streaming={thinking}
                      startedAt={latestRequest?.createdAt}
                      thoughtForMs={thoughtFor(message)}
                    />
                  ),
                }
              : {})}
            {...(showLinks || showFollowUps
              ? {
                  actions: (
                    <>
                      {showLinks
                        ? state.officialLinks.map((link) => (
                            <LinkChip key={link.href} href={link.href}>
                              {link.label}
                            </LinkChip>
                          ))
                        : null}
                      {showFollowUps
                        ? followUps.map((suggestion) => (
                            <GuideChip key={suggestion} disabled={disabled} onClick={() => void ask(suggestion)}>
                              {suggestion}
                            </GuideChip>
                          ))
                        : null}
                    </>
                  ),
                }
              : {})}
          />
        )
      })}

      {showThinking ? <ThinkingTurn startedAt={latestRequest?.createdAt} /> : null}

      {latestRequest?.state === 'failed' && latestRequest.failureMessage ? (
        <GuideNotice message={latestRequest.failureMessage}>
          {lastUserText ? (
            <GuideChip accent disabled={disabled} onClick={() => void ask(lastUserText)}>
              Try again
            </GuideChip>
          ) : null}
          {humanSupport === null ? (
            <GuideChip disabled={disabled} onClick={() => setEscalating(true)}>
              Bring in the team
            </GuideChip>
          ) : null}
        </GuideNotice>
      ) : null}

      {error ? (
        <p role="alert" className="m-0 text-[12.5px] text-rose-light">
          {error}
        </p>
      ) : null}
    </GuideStage>
  )
}
