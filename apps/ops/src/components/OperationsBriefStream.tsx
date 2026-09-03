import { api } from "@code2create/backend/api";
import { useAction } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useCallback } from "react";

import { eventSlug } from "../lib/config";
import {
  intelligenceConnectionState,
  intelligenceTerminalState,
} from "../lib/intelligenceConversation";
import { useIntelligenceStream } from "../lib/useIntelligenceStream";
import { LiveAgentConsole } from "./intelligence";

export function OperationsBriefStream({
  briefId,
  isActive,
}: {
  briefId: FunctionArgs<typeof api.operationsIntelligenceActions.openBriefStream>["briefId"];
  isActive: boolean;
}) {
  const openStream = useAction(api.operationsIntelligenceActions.openBriefStream);
  const loadAccess = useCallback(() => openStream({ eventSlug, briefId }), [briefId, openStream]);
  const stream = useIntelligenceStream({
    enabled: true,
    loadAccess,
    streamKey: `brief:${briefId}`,
  });
  const connectionState = intelligenceConnectionState({
    accessFailed: stream.accessError !== undefined,
    historyReady: stream.historyReady,
    streamFailed: stream.error !== undefined,
    status: stream.status,
  });

  return (
    <div className="intelligence-brief-stream">
      <LiveAgentConsole
        agentLabel="Brief agent"
        connectionState={connectionState}
        embedded
        emptyDescription="Steps appear here once the agent starts reading the event snapshot."
        emptyTitle="Waiting for the agent to start."
        historyCanLoadMore={stream.historyCanLoadMore}
        {...(stream.historyLoadError === undefined
          ? {}
          : { historyLoadError: stream.historyLoadError })}
        historyLoading={stream.historyLoading}
        isStreaming={isActive || stream.status === "submitted" || stream.status === "streaming"}
        messages={stream.messages}
        onLoadOlder={stream.loadOlder}
        onReconnect={stream.reconnect}
        showOperatorMessages={false}
        terminalState={intelligenceTerminalState(stream.settlements)}
        terminalCopy={{
          completed: {
            title: "Done",
            detail: "The brief above is the final result.",
          },
          failed: {
            title: "The brief did not finish",
            detail: "The failure is recorded above. You can request another brief.",
          },
          aborted: {
            title: "The brief was stopped",
            detail: "Nothing more is running for it.",
          },
        }}
        workingCopy={{
          title: "Preparing brief",
          detail: "The agent is reading the event snapshot.",
        }}
      />
    </div>
  );
}
