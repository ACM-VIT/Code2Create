import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVersionedSessionDraft,
  sessionDraftConflicts,
  serializeVersionedSessionDraft,
} from "./sessionDraft.ts";

test("a recovered draft preserves the server base it was written against", () => {
  const stored = serializeVersionedSessionDraft({
    base: "application:4:content:3:project:project-2:7",
    value: "A participant-authored proposal.",
  });

  assert.deepEqual(parseVersionedSessionDraft(stored), {
    base: "application:4:content:3:project:project-2:7",
    value: "A participant-authored proposal.",
  });
});

test("legacy and malformed storage cannot masquerade as a current draft", () => {
  assert.equal(parseVersionedSessionDraft("plain unsaved text"), null);
  assert.equal(parseVersionedSessionDraft("version=1&value=missing-base"), null);
  assert.equal(parseVersionedSessionDraft(null), null);
});

test("a recovered draft conflicts whenever its exact server base has changed", () => {
  const draft = {
    base: "application:4:content:3:project:project-2:7",
    value: "A participant-authored proposal.",
  };

  assert.equal(sessionDraftConflicts(draft, draft.base), false);
  assert.equal(sessionDraftConflicts(draft, "application:4:content:4:project:project-2:7"), true);
  assert.equal(sessionDraftConflicts(null, draft.base), false);
});
