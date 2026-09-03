import { api } from "@code2create/backend/api";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useState } from "react";

import { eventSlug } from "../lib/config";
import { copilotSuggestedPrompts } from "../lib/copilotPrompts";
import {
  intelligenceConnectionState,
  intelligenceTerminalState,
  latestActiveSubmissionId,
  observedSubmissionId,
  submissionIsActive,
} from "../lib/intelligenceConversation";
import { useIntelligenceStream } from "../lib/useIntelligenceStream";
import { useOperationRunner } from "../lib/operations";
import { LiveAgentConsole } from "./intelligence";
import { CopilotCommandTray } from "./intelligence/CopilotCommandTray";

type TurnResult = FunctionReturnType<typeof api.operationsIntelligenceActions.submitCopilotTurn>;

type PendingTurn = {
  turnId: string;
};

export function OperationsCopilotConsole({
  canGenerate,
  canRead,
  initialPrompt,
}: {
  canGenerate: boolean;
  canRead: boolean;
  initialPrompt?: string;
}) {
  const openStream = useAction(api.operationsIntelligenceActions.openCopilotStream);
  const submitTurn = useAction(api.operationsIntelligenceActions.submitCopilotTurn);
  const loadAccess = useCallback(() => openStream({ eventSlug }), [openStream]);
  const stream = useIntelligenceStream({
    enabled: canRead,
    loadAccess,
    streamKey: `copilot:${eventSlug}`,
  });
  const reconnectStream = stream.reconnect;
  const operations = useOperationRunner<TurnResult>();
  const [pendingTurn, setPendingTurn] = useState<PendingTurn>();
  const [activeSubmissionId, setActiveSubmissionId] = useState<string>();

  const clearPendingTurn = useCallback(() => {
    setPendingTurn(undefined);
  }, []);
  const observedPendingSubmissionId =
    pendingTurn !== undefined && canRead
      ? observedSubmissionId(stream.messages, pendingTurn.turnId)
      : undefined;

  useEffect(() => {
    if (observedPendingSubmissionId === undefined) return;
    operations.confirmExactObservation("copilot-turn");
  }, [observedPendingSubmissionId, operations]);

  const observedActiveSubmissionId = latestActiveSubmissionId(stream.messages, stream.settlements);
  const durableActiveSubmissionId =
    observedActiveSubmissionId ?? observedPendingSubmissionId ?? activeSubmissionId;

  const submitPrompt = useCallback(
    async (prompt: string) => {
      try {
        const result = await operations.run("copilot-turn", (turnId) => {
          const command = { turnId };
          setPendingTurn(command);
          return () => submitTurn({ eventSlug, turnId, message: prompt });
        });
        if (canRead) setActiveSubmissionId(result.submissionId);
        clearPendingTurn();
        if (canRead) reconnectStream();
      } catch (caught) {
        if (!operations.hasPending("copilot-turn")) clearPendingTurn();
        throw caught;
      }
    },
    [canRead, clearPendingTurn, operations, reconnectStream, submitTurn],
  );

  const hasPendingTurn = operations.hasPending("copilot-turn");
  const active = submissionIsActive(stream.settlements, durableActiveSubmissionId);
  const isStreaming = stream.status === "submitted" || stream.status === "streaming" || active;
  const connectionState = canRead
    ? intelligenceConnectionState({
        accessFailed: stream.accessError !== undefined,
        historyReady: stream.historyReady,
        streamFailed: stream.error !== undefined,
        status: stream.status,
      })
    : "connected";
  const terminalState = intelligenceTerminalState(stream.settlements, durableActiveSubmissionId);

  return (
    <LiveAgentConsole
      {...(initialPrompt === undefined ? {} : { autoSubmitPrompt: initialPrompt })}
      composerDisabled={!canGenerate}
      composerPendingConfirmation={hasPendingTurn}
      composerRequiresConnection={false}
      composerResetKey={observedPendingSubmissionId === undefined ? 0 : 1}
      connectionState={connectionState}
      emptyDescription={
        canRead
          ? "Answers come from live, cited event reads: review flow, check-in, the hall, the help desk, and admissions. When a change is needed, the copilot drafts a command for you to approve."
          : "You can send a question, but intelligence read access is required to view its response."
      }
      emptyTitle={canRead ? "Ask about the live event." : "Ask an event question."}
      historyCanLoadMore={canRead && stream.historyCanLoadMore}
      {...(canRead && stream.historyLoadError !== undefined
        ? { historyLoadError: stream.historyLoadError }
        : {})}
      historyLoading={canRead && stream.historyLoading}
      isStreaming={isStreaming}
      messages={canRead ? stream.messages : []}
      {...(canRead ? { onLoadOlder: stream.loadOlder } : {})}
      onReconnect={stream.reconnect}
      {...(canGenerate ? { onSubmitPrompt: submitPrompt } : {})}
      suggestions={copilotSuggestedPrompts}
      terminalState={canRead ? terminalState : "none"}
      {...(canRead ? { timelineFooter: <CopilotCommandTray /> } : {})}
    />
  );
}
