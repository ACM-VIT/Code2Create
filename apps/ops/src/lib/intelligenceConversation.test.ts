import assert from "node:assert/strict";
import test from "node:test";
import type { FlueConversationMessage, FlueConversationSettlement } from "@flue/react";

import {
  intelligenceConnectionState,
  intelligenceTerminalState,
  latestActiveSubmissionId,
  observedSubmissionId,
  submissionIsActive,
} from "./intelligenceConversation.ts";

test("reconciles an ambiguously accepted turn only through its exact durable turn id", () => {
  const messages: FlueConversationMessage[] = [
    {
      id: "message-a",
      role: "user",
      purpose: "user",
      display: "visible",
      turnId: "copilot-turn:original",
      submissionId: "submission-a",
      parts: [{ type: "text", text: "First prompt", state: "done" }],
    },
    {
      id: "message-b",
      role: "user",
      purpose: "user",
      display: "visible",
      turnId: "copilot-turn:different",
      submissionId: "submission-b",
      parts: [{ type: "text", text: "Second prompt", state: "done" }],
    },
  ];

  assert.equal(observedSubmissionId(messages, "copilot-turn:original"), "submission-a");
  assert.equal(observedSubmissionId(messages, "copilot-turn:missing"), undefined);
});

test("derives connection and exact submission lifecycle without parsing prose", () => {
  assert.equal(
    intelligenceConnectionState({
      accessFailed: false,
      historyReady: false,
      streamFailed: false,
      status: "idle",
    }),
    "connecting",
  );
  assert.equal(
    intelligenceConnectionState({
      accessFailed: false,
      historyReady: true,
      streamFailed: false,
      status: "connecting",
    }),
    "reconnecting",
  );
  assert.equal(
    intelligenceConnectionState({
      accessFailed: true,
      historyReady: true,
      streamFailed: false,
      status: "idle",
    }),
    "offline",
  );
  assert.equal(
    intelligenceConnectionState({
      accessFailed: false,
      historyReady: true,
      streamFailed: true,
      status: "streaming",
    }),
    "reconnecting",
  );

  const settlements: FlueConversationSettlement[] = [
    { submissionId: "submission-a", outcome: "completed" },
    { submissionId: "submission-b", outcome: "aborted" },
  ];
  assert.equal(submissionIsActive(settlements, "submission-c"), true);
  assert.equal(submissionIsActive(settlements, "submission-a"), false);
  assert.equal(intelligenceTerminalState(settlements, "submission-a"), "completed");
  assert.equal(intelligenceTerminalState(settlements), "aborted");
  assert.equal(latestActiveSubmissionId([], settlements), undefined);
});

test("recovers an unsettled durable submission after the console remounts", () => {
  const messages: FlueConversationMessage[] = [
    {
      id: "message-a",
      role: "user",
      purpose: "user",
      display: "visible",
      submissionId: "submission-a",
      parts: [{ type: "text", text: "Already finished", state: "done" }],
    },
    {
      id: "message-b",
      role: "user",
      purpose: "user",
      display: "visible",
      submissionId: "submission-b",
      parts: [{ type: "text", text: "Still running", state: "done" }],
    },
  ];

  assert.equal(
    latestActiveSubmissionId(messages, [{ submissionId: "submission-a", outcome: "completed" }]),
    "submission-b",
  );
  assert.equal(
    latestActiveSubmissionId(messages, [
      { submissionId: "submission-a", outcome: "completed" },
      { submissionId: "submission-b", outcome: "failed" },
    ]),
    undefined,
  );
});
