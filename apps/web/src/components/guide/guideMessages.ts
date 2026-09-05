import type { UIMessage } from "@convex-dev/agent/react";
import type { GuideStep } from "./GuideReasoning";

type GuideMessageEntry = {
  kind: "guide";
  at: number;
  message: UIMessage;
  reasoning: string;
  steps: GuideStep[];
  thoughtForMs: number | undefined;
};

function stepLabel(tool: string, state: GuideStep["state"]) {
  if (tool === "bringInEventTeam") {
    return state === "done"
      ? "Brought the event team into this conversation"
      : state === "failed"
        ? "Could not reach the event team"
        : "Bringing in the event team";
  }
  const name = tool.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return state === "done"
    ? `Finished: ${name}`
    : state === "failed"
      ? `Failed: ${name}`
      : `Working: ${name}`;
}

/** Keep prompt timing and display data together without rescanning earlier messages. */
export function projectGuideMessages(messages: readonly UIMessage[]) {
  const entries: GuideMessageEntry[] = [];
  const asked = new Set<string>();
  let lastGuideKey: string | null = null;
  let lastUserText: string | null = null;
  let promptAt: number | undefined;
  const lastMessage = messages.at(-1);
  const answerStarted = lastMessage?.role === "assistant" && lastMessage.status === "streaming";

  for (const message of messages) {
    const text = message.text.trim();
    const spoken = message.role !== "system" && text.length > 0;
    if (!spoken && !(answerStarted && message === lastMessage)) continue;

    if (spoken && message.role === "user") {
      asked.add(text);
      lastUserText = message.text;
      promptAt = message._creationTime;
    }
    if (spoken && message.role === "assistant") lastGuideKey = message.key;

    const reasoning: string[] = [];
    const steps: GuideStep[] = [];
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type === "reasoning") reasoning.push(part.text);
        if (!("toolCallId" in part) || !("state" in part)) continue;
        const tool = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
        const state: GuideStep["state"] =
          part.state === "output-available"
            ? "done"
            : part.state === "output-error"
              ? "failed"
              : "running";
        steps.push({ key: part.toolCallId, label: stepLabel(tool, state), state });
      }
    }
    entries.push({
      kind: "guide",
      at: message._creationTime,
      message,
      reasoning: reasoning.join("\n\n"),
      steps,
      thoughtForMs:
        message.role === "assistant" && promptAt !== undefined
          ? Math.max(0, message._creationTime - promptAt)
          : undefined,
    });
  }

  return { entries, asked, lastGuideKey, lastUserText, answerStarted };
}
