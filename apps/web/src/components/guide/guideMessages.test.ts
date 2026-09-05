import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "@convex-dev/agent/react";
import { projectGuideMessages } from "./guideMessages.ts";

function message(
  key: string,
  role: UIMessage["role"],
  text: string,
  at: number,
  overrides: Partial<Pick<UIMessage, "status" | "parts">> = {},
): UIMessage {
  return {
    id: key, key, role, text, _creationTime: at,
    order: at, stepOrder: 0, status: "success", parts: [],
    ...overrides,
  };
}

test("keeps visible history, original question text, and trimmed follow-up exclusions", () => {
  const messages = [
    message("system", "system", "Internal context", 0),
    message("welcome", "assistant", "Welcome", 1),
    message("blank", "user", " \n ", 2),
    message("question", "user", "  Where is the desk? \n", 3),
    message("answer", "assistant", "At reception", 5),
    message("hidden", "assistant", "", 6),
    message("repeat", "user", "Where is the desk?", 7),
  ];
  const result = projectGuideMessages(messages);
  assert.deepEqual(result.entries.map((entry) => entry.message.key), [
    "welcome", "question", "answer", "repeat",
  ]);
  assert.deepEqual([...result.asked], ["Where is the desk?"]);
  assert.equal(result.lastGuideKey, "answer");
  assert.equal(result.lastUserText, "Where is the desk?");
  assert.equal(result.entries[1]?.message.text, "  Where is the desk? \n");
  assert.equal(result.answerStarted, false);
  assert.equal(result.entries[0]?.thoughtForMs, undefined);
  assert.equal(result.entries[2]?.thoughtForMs, 2);
});

test("retains an empty live answer without making it the last spoken answer", () => {
  const messages = [
    message("answer", "assistant", "Previous answer", 0),
    message("question", "user", "What comes next?", 10),
    message("live", "assistant", "", 15, {
      status: "streaming", parts: [{ type: "reasoning", text: "Checking the schedule" }],
    }),
  ];
  const result = projectGuideMessages(messages);
  assert.equal(result.answerStarted, true);
  assert.equal(result.lastGuideKey, "answer");
  assert.equal(result.entries.at(-1)?.message.key, "live");
  assert.equal(result.entries.at(-1)?.reasoning, "Checking the schedule");
  assert.equal(result.entries.at(-1)?.thoughtForMs, 5);

  const next = projectGuideMessages([...messages, message("context", "system", "Hidden", 20)]);
  assert.equal(next.answerStarted, false);
  assert.deepEqual(next.entries.map((entry) => entry.message.key), ["answer", "question"]);
});

test("measures every answer from the preceding visible question, including zero and skewed times", () => {
  const result = projectGuideMessages([
    message("first-question", "user", "First question", 0),
    message("first-answer", "assistant", "Answer part one", 8),
    message("second-answer", "assistant", "Answer part two", 12),
    message("blank-question", "user", " ", 14),
    message("third-answer", "assistant", "Answer part three", 16),
    message("new-question", "user", "Next question", 30),
    message("skewed-answer", "assistant", "Early timestamp", 25),
  ]);
  assert.deepEqual(
    result.entries.filter((entry) => entry.message.role === "assistant")
      .map((entry) => entry.thoughtForMs),
    [8, 12, 16, 0],
  );
});

test("preserves reasoning and tool order, labels, and running, successful, and failed states", () => {
  const answer = message("answer", "assistant", "Here is the answer", 10, {
    parts: [
      { type: "reasoning", text: "First thought" },
      { type: "tool-readSchedule", toolCallId: "read", state: "input-available", input: {} },
      { type: "reasoning", text: "Second thought" },
      { type: "dynamic-tool", toolName: "bringInEventTeam", toolCallId: "join", state: "output-available", input: {}, output: {} },
      { type: "tool-bringInEventTeam", toolCallId: "retry", state: "output-error", input: {}, errorText: "Unavailable" },
      { type: "tool-readSchedule", toolCallId: "finished", state: "output-available", input: {}, output: {} },
      { type: "tool-readSchedule", toolCallId: "failed", state: "output-error", input: {}, errorText: "Unavailable" },
    ],
  });
  const original = structuredClone(answer);
  const entry = projectGuideMessages(Object.freeze([answer])).entries[0];
  assert.equal(entry?.reasoning, "First thought\n\nSecond thought");
  assert.deepEqual(entry?.steps, [
    { key: "read", label: "Working: read schedule", state: "running" },
    { key: "join", label: "Brought the event team into this conversation", state: "done" },
    { key: "retry", label: "Could not reach the event team", state: "failed" },
    { key: "finished", label: "Finished: read schedule", state: "done" },
    { key: "failed", label: "Failed: read schedule", state: "failed" },
  ]);
  assert.equal(entry?.message, answer);
  assert.deepEqual(answer, original);
});
