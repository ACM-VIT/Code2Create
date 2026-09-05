import { api } from "@code2create/backend/api";
import type { SupportCaseState } from "@code2create/domain";
import { useUIMessages } from "@convex-dev/agent/react";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { eventSlug } from "../../lib/config";
import { readableError } from "../../lib/errors";
import { ShimmerText } from "../portal/ShimmerText";
import { useMutationAttempt } from "../../lib/operations";
import { BringTeamTool, GuideComposer } from "./GuideComposer";
import { LoadingLine } from "./GuideLoader";
import { GuideReasoning } from "./GuideReasoning";
import { projectGuideMessages } from "./guideMessages";
import { GuideStage } from "./GuideStage";
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
} from "./GuideTurns";

type Conversation = FunctionReturnType<typeof api.participantAssistant.openConversation>;
type SendMessageResult = FunctionReturnType<typeof api.participantAssistant.sendMessage>;

const escalationPrompt = "Please bring someone from the event team into this conversation.";
const sendMessageSlot = "send-participant-assistant-message";

function momentName(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function clockName(value: number) {
  return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function teamStateName(state: SupportCaseState) {
  switch (state) {
    case "open":
      return "someone will pick this up";
    case "investigating":
      return "looking into it";
    case "waiting":
      return "waiting on you";
    case "resolved":
      return "marked resolved";
    case "closed":
      return "closed";
  }
}

/**
 * Help, as one conversation. Opening the Guide creates or resumes the
 * participant's thread; everything after that is the live thread.
 */
export function GuideConversation() {
  const openConversation = useMutation(api.participantAssistant.openConversation);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void openConversation({ eventSlug })
      .then((result) => {
        if (mounted) setConversation(result);
      })
      .catch((caught: unknown) => {
        if (mounted) setError(readableError(caught));
      });
    return () => {
      mounted = false;
    };
  }, [openConversation]);

  if (error !== null) {
    return (
      <div className="flex h-full w-full max-w-[760px] items-center justify-center">
        <GuideNotice message={`The Guide couldn’t open. ${error}`}>
          <span className="text-[12px] text-fg/55">
            Refresh to try again, or ask an organizer at the event desk.
          </span>
        </GuideNotice>
      </div>
    );
  }
  if (conversation === null) {
    return (
      <div role="status" className="flex h-full w-full max-w-[760px] items-center justify-center">
        <ShimmerText className="text-[15px] text-fg/70">Getting your Guide ready</ShimmerText>
      </div>
    );
  }
  return <GuideThread conversation={conversation} />;
}

function GuideThread({ conversation }: { conversation: Conversation }) {
  const sendMessage = useMutation(api.participantAssistant.sendMessage);
  const sendAttempt = useMutationAttempt<SendMessageResult>();
  const sendPending = sendAttempt.hasPending(sendMessageSlot);
  const liveState = useQuery(api.participantAssistant.conversationState, {
    eventSlug,
    threadId: conversation.threadId,
  });
  const {
    results: messages,
    status: messageStatus,
    loadMore,
  } = useUIMessages(
    api.participantAssistant.listMessages,
    { eventSlug, threadId: conversation.threadId },
    { initialNumItems: 40, stream: true },
  );
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wasAnsweringRef = useRef(false);

  const state = liveState ?? conversation;
  const latestRequest = state.latestRequest;
  const humanSupport = state.humanSupport;
  const isAnswering = latestRequest?.state === "scheduled" || latestRequest?.state === "running";
  const disabled = sending || isAnswering;
  const interactionsDisabled = disabled || sendPending;

  const { entries, asked, lastGuideKey, lastUserText, answerStarted } = useMemo(
    () => projectGuideMessages(messages),
    [messages],
  );
  // Once the answer has started arriving, the thread shows it in place; until
  // then the Guide is only thinking, and the loading line stands in.
  const showThinking = isAnswering && !answerStarted;
  const followUps = state.suggestions.filter((suggestion) => !asked.has(suggestion));
  const timeline = useMemo(
    () => [
      ...entries,
      ...(humanSupport
        ? [
            { kind: "joined" as const, at: humanSupport.joinedAt },
            ...humanSupport.messages.map((message) => ({
              kind: "team" as const,
              at: message.createdAt,
              message,
            })),
          ]
        : []),
    ].sort((left, right) => left.at - right.at),
    [entries, humanSupport],
  );

  useEffect(() => {
    if (wasAnsweringRef.current && !isAnswering) textareaRef.current?.focus();
    wasAnsweringRef.current = isAnswering;
  }, [isAnswering]);

  const ask = async (value: string) => {
    const message = value.trim();
    if ((!sendPending && message.length < 2) || busyRef.current || isAnswering) return;
    busyRef.current = true;
    setSending(true);
    setError(null);
    try {
      await sendAttempt.run(sendMessageSlot, () => {
        const args = {
          eventSlug,
          threadId: conversation.threadId,
          message,
          clientRequestId: crypto.randomUUID(),
        };
        return () => sendMessage(args);
      });
      setQuestion("");
      setEscalating(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  };

  const teamLine = humanSupport ? `event team ${teamStateName(humanSupport.state)}` : undefined;

  return (
    <GuideStage
      header={
        <GuideHeader
          phaseLabel={state.phase.label}
          deadline={
            state.phase.deadline === undefined ? undefined : momentName(state.phase.deadline)
          }
          team={teamLine}
        />
      }
      composer={
        <GuideComposer
          value={question}
          onChange={setQuestion}
          onSend={() => void ask(question)}
          disabled={disabled}
          confirming={sendPending}
          answering={isAnswering}
          textareaRef={textareaRef}
          {...(humanSupport === null
            ? {
                leading: (
                  <BringTeamTool
                    disabled={interactionsDisabled || escalating}
                    onClick={() => setEscalating(true)}
                  />
                ),
              }
            : {})}
          {...(escalating
            ? {
                confirm: {
                  question: "Bring the event team into this thread?",
                  confirmLabel: "Bring them in",
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
            disabled={interactionsDisabled}
            onPick={(suggestion) => void ask(suggestion)}
          />
        </div>
      ) : null}

      {messageStatus === "CanLoadMore" ? (
        <div className="flex justify-center">
          <GuideChip onClick={() => loadMore(40)}>Show earlier messages</GuideChip>
        </div>
      ) : messageStatus === "LoadingMore" ? (
        <div className="flex justify-center">
          <LoadingLine label="Loading earlier messages" />
        </div>
      ) : null}

      {timeline.map((entry) => {
        if (entry.kind === "joined") {
          return (
            <SystemLine key="joined">the event team joined · {clockName(entry.at)}</SystemLine>
          );
        }
        if (entry.kind === "team") {
          return <TeamTurn key={entry.message.id} body={entry.message.body} />;
        }
        const message = entry.message;
        if (message.role !== "assistant") return <UserTurn key={message.key} text={message.text} />;
        const streaming = message.status === "streaming";
        const thinking = streaming && message.text.trim().length === 0;
        const { reasoning, steps } = entry;
        const latest = message.key === lastGuideKey;
        const showLinks = latest && !streaming && state.officialLinks.length > 0;
        const showFollowUps = latest && !streaming && !isAnswering && followUps.length > 0;
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
                      thoughtForMs={entry.thoughtForMs}
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
                            <GuideChip
                              key={suggestion}
                              disabled={interactionsDisabled}
                              onClick={() => void ask(suggestion)}
                            >
                              {suggestion}
                            </GuideChip>
                          ))
                        : null}
                    </>
                  ),
                }
              : {})}
          />
        );
      })}

      {showThinking ? <ThinkingTurn startedAt={latestRequest?.createdAt} /> : null}

      {latestRequest?.state === "failed" && latestRequest.failureMessage ? (
        <GuideNotice message={latestRequest.failureMessage}>
          {lastUserText ? (
            <GuideChip
              accent
              disabled={interactionsDisabled}
              onClick={() => void ask(lastUserText)}
            >
              Try again
            </GuideChip>
          ) : null}
          {humanSupport === null ? (
            <GuideChip disabled={interactionsDisabled} onClick={() => setEscalating(true)}>
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
  );
}
