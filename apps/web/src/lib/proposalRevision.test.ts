import assert from "node:assert/strict";
import test from "node:test";

import {
  proposalRevisionBase,
  proposalRevisionBaseFingerprint,
  proposalRevisionRegeneratesQuestions,
  recoverProposalRevision,
} from "./proposalRevision.ts";

test("operational application updates do not create proposal conflicts", () => {
  const project = { id: "project-version-1", version: 1 };
  const beforeApplication = { contentVersion: 1, version: 4 };
  const afterApplication = { contentVersion: 1, version: 5 };
  const before = proposalRevisionBase(beforeApplication, project);
  const after = proposalRevisionBase(afterApplication, project);

  assert.equal(proposalRevisionBaseFingerprint(before), proposalRevisionBaseFingerprint(after));
});

test("idea and upstream answer changes regenerate only when later questions depend on them", () => {
  const savedResponses = [
    { ordinal: 1, answer: "First fixed answer" },
    { ordinal: 2, answer: "Second fixed answer" },
    { ordinal: 3, answer: "First generated answer" },
    { ordinal: 4, answer: "Last generated answer" },
  ];
  const unchangedResponses = savedResponses.map(({ answer }) => ({ answer }));

  assert.equal(
    proposalRevisionRegeneratesQuestions({
      savedIdea: "Original idea",
      nextIdea: "Meaningfully changed idea",
      savedResponses,
      nextResponses: unchangedResponses,
      deterministicFollowUpCount: 2,
      maximumFollowUpCount: 4,
    }),
    true,
  );
  assert.equal(
    proposalRevisionRegeneratesQuestions({
      savedIdea: "Original idea",
      nextIdea: "Original idea",
      savedResponses,
      nextResponses: savedResponses.map((response) => ({
        answer: response.ordinal === 3 ? "Changed generated answer" : response.answer,
      })),
      deterministicFollowUpCount: 2,
      maximumFollowUpCount: 4,
    }),
    true,
  );
  assert.equal(
    proposalRevisionRegeneratesQuestions({
      savedIdea: "Original idea",
      nextIdea: " Original idea\r\n",
      savedResponses,
      nextResponses: savedResponses.map((response) => ({
        answer: response.ordinal === 4 ? "Changed final answer" : response.answer,
      })),
      deterministicFollowUpCount: 2,
      maximumFollowUpCount: 4,
    }),
    false,
  );
});

test("content and project changes still create proposal conflicts", () => {
  const initial = proposalRevisionBase(
    { contentVersion: 1 },
    { id: "project-version-1", version: 1 },
  );
  const revisedContent = proposalRevisionBase(
    { contentVersion: 2 },
    { id: "project-version-2", version: 2 },
  );

  assert.notEqual(
    proposalRevisionBaseFingerprint(initial),
    proposalRevisionBaseFingerprint(revisedContent),
  );
});

test("a pending answer revision survives navigation before autosave runs", () => {
  assert.deepEqual(
    recoverProposalRevision("Saved answer", 8, {
      base: "8",
      value: "Pending answer revision",
    }),
    {
      answer: "Pending answer revision",
      baseDraftVersion: 8,
      recovered: true,
    },
  );
});

test("deleting an answer remains a pending revision instead of restoring saved text", () => {
  assert.deepEqual(
    recoverProposalRevision("Saved answer", 8, {
      base: "8",
      value: "",
    }),
    {
      answer: "",
      baseDraftVersion: 8,
      recovered: true,
    },
  );
});

test("a redundant or malformed revision draft does not replace the saved answer", () => {
  assert.deepEqual(
    recoverProposalRevision("Saved answer", 8, {
      base: "not-a-version",
      value: "Pending answer revision",
    }),
    {
      answer: "Saved answer",
      baseDraftVersion: 8,
      recovered: false,
    },
  );
  assert.equal(
    recoverProposalRevision("Saved answer", 8, {
      base: "7",
      value: "Saved answer",
    }).recovered,
    false,
  );
});
