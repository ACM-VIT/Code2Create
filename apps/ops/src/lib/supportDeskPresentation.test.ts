import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSupportCases,
  formatSupportAge,
  groupSupportCases,
  supportEventText,
  supportExcerpt,
  supportFilterCount,
  supportGuideNote,
  supportLeadSentence,
  supportMessageRole,
  supportMessageTag,
  supportOwnerReason,
  supportQueueGroup,
  supportRowOwner,
  supportRowStatus,
  supportRowTone,
  supportStatusChoices,
  supportUpdateReason,
} from "./supportDeskPresentation.ts";

const minute = 60_000;
const now = 1_800_000_000_000;

const base = {
  category: "team" as const,
  state: "open" as const,
  awaitingStaffReply: true,
  createdAt: now - 26 * minute,
  lastActionAt: now - 26 * minute,
};

test("the queue puts safety first, then whoever is owed a reply with nobody assigned", () => {
  const safety = { ...base, category: "safety" as const, lastActionAt: now - 2 * minute };
  const unownedReply = { ...base, lastActionAt: now - 5 * minute };
  const ownedReply = { ...base, ownerName: "Priya Menon", lastActionAt: now - 40 * minute };
  const replied = { ...base, state: "investigating" as const, awaitingStaffReply: false };
  const parked = { ...base, state: "waiting" as const, awaitingStaffReply: false };
  const resolved = {
    ...base,
    state: "resolved" as const,
    awaitingStaffReply: false,
    lastActionAt: now - 3 * minute,
  };
  const olderResolved = { ...resolved, lastActionAt: now - 90 * minute };
  const closed = { ...base, state: "closed" as const, awaitingStaffReply: false };

  const groups = groupSupportCases([
    closed,
    olderResolved,
    parked,
    replied,
    ownedReply,
    unownedReply,
    resolved,
    safety,
  ]);
  assert.deepEqual(
    groups.map((group) => group.group),
    ["safety", "reply", "working", "reporter", "resolved", "closed"],
  );
  assert.deepEqual(groups[1]?.cases, [unownedReply, ownedReply]);
  assert.deepEqual(groups[4]?.cases, [resolved, olderResolved]);
  assert.equal(groups[0]?.label, "Safety first");
});

test("within a group the desk sees its oldest silence first", () => {
  const older = { ...base, lastActionAt: now - 30 * minute };
  const newer = { ...base, lastActionAt: now - 3 * minute };
  assert.ok(compareSupportCases(older, newer) < 0);
  assert.equal(
    supportQueueGroup({ ...base, state: "waiting", awaitingStaffReply: false }),
    "reporter",
  );
});

test("a row says what the desk is waiting for and who has it", () => {
  assert.equal(supportRowStatus(base, now), "No reply yet · reported 26 min ago");
  assert.equal(
    supportRowStatus(
      { ...base, firstResponseAt: now - 20 * minute, lastActionAt: now - 3 * minute },
      now,
    ),
    "Wrote back 3 min ago",
  );
  assert.equal(
    supportRowStatus(
      { ...base, state: "investigating", awaitingStaffReply: false, lastActionAt: now - minute },
      now,
    ),
    "Being looked at · replied 1 min ago",
  );
  assert.equal(
    supportRowStatus(
      { ...base, state: "waiting", awaitingStaffReply: false, lastActionAt: now - 2 * 60 * minute },
      now,
    ),
    "With the reporter · 2 h ago",
  );
  assert.equal(
    supportRowStatus({ ...base, state: "resolved", awaitingStaffReply: false }, now),
    "Resolved 26 min ago",
  );
  assert.deepEqual(supportRowOwner(base), { label: "Nobody assigned", missing: true });
  assert.deepEqual(supportRowOwner({ ...base, ownerName: "Priya Menon" }), {
    label: "Priya Menon",
    missing: false,
  });
  assert.equal(supportRowOwner({ ...base, state: "closed" }), null);
});

test("a request owed a reply turns critical once the desk has been silent for an hour", () => {
  assert.equal(supportRowTone(base, now), "attention");
  assert.equal(supportRowTone({ ...base, lastActionAt: now - 61 * minute }, now), "critical");
  assert.equal(supportRowTone({ ...base, category: "safety" }, now), "critical");
  assert.equal(
    supportRowTone({ ...base, state: "waiting", awaitingStaffReply: false }, now),
    "watch",
  );
  assert.equal(
    supportRowTone({ ...base, state: "closed", awaitingStaffReply: false }, now),
    "quiet",
  );
});

test("the excerpt drops the Guide routing prefix and cuts on a word", () => {
  assert.deepEqual(
    supportExcerpt(
      "Guide handoff: Participant Divyam says they registered with 5 people.\n\nMore.",
    ),
    { text: "Participant Divyam says they registered with 5 people. More.", viaGuide: true },
  );
  const long = supportExcerpt("one two three four five six seven eight nine ten eleven twelve", 30);
  assert.equal(long.text, "one two three four five six…");
  assert.equal(long.viaGuide, false);
});

test("filter chips count what the filter would show", () => {
  const totals = {
    open: 2,
    investigating: 1,
    waiting: 1,
    resolved: 3,
    closed: 4,
    unowned: 1,
    awaitingStaffReply: 2,
    safety: 0,
  };
  assert.equal(supportFilterCount("active", totals), 4);
  assert.equal(supportFilterCount("resolved", totals), 3);
  assert.equal(supportFilterCount("closed", totals), 4);
  assert.equal(supportFilterCount("all", totals), 11);
  assert.equal(
    supportLeadSentence("active", totals),
    "2 requests are waiting on a reply from the desk. 1 has nobody assigned.",
  );
  assert.equal(
    supportLeadSentence("active", { ...totals, open: 0, investigating: 0, waiting: 0 }),
    "Nothing is open. Nobody is waiting on the desk.",
  );
});

test("the status list starts with the current state and only offers allowed moves", () => {
  assert.deepEqual(supportStatusChoices("investigating"), [
    "investigating",
    "open",
    "waiting",
    "resolved",
    "closed",
  ]);
  assert.deepEqual(supportStatusChoices("closed"), ["closed", "open"]);
});

test("the thread tells Guide notes and system events apart from people", () => {
  assert.equal(supportMessageRole({ kind: "opened", actorName: "Divyam" }), "reporter");
  assert.equal(supportMessageRole({ kind: "public_note", actorName: "Desk" }), "staff");
  assert.equal(supportMessageRole({ kind: "internal_note", actorName: "Desk" }), "internal");
  assert.equal(
    supportMessageRole({ kind: "internal_note", actorName: "Code2Create Guide" }),
    "guide",
  );
  assert.equal(supportMessageRole({ kind: "state_changed", actorName: "Desk" }), "system");

  assert.deepEqual(
    supportGuideNote("Code2Create Guide handoff\n\nSummary here\n\nConversation so far\n..."),
    {
      kind: "handoff",
      text: "Summary here\n\nConversation so far\n...",
    },
  );
  assert.deepEqual(supportGuideNote("Code2Create Guide reply\n\nYour team is DESYNC."), {
    kind: "reply",
    text: "Your team is DESYNC.",
  });
  assert.equal(supportGuideNote("Plain desk note"), null);

  assert.equal(
    supportMessageTag({
      kind: "internal_note",
      actorName: "Code2Create Guide",
      body: "Code2Create Guide handoff\n\nx",
    }),
    "handed this to the desk",
  );
  assert.equal(
    supportMessageTag({
      kind: "internal_note",
      actorName: "Code2Create Guide",
      body: "Code2Create Guide reply\n\nx",
    }),
    "answered the participant",
  );
  assert.equal(
    supportMessageTag({ kind: "internal_note", actorName: "Desk", body: "uh" }),
    "desk note",
  );
  assert.equal(
    supportMessageTag({ kind: "reporter_reply", actorName: "Divyam", body: "hi" }),
    "wrote back",
  );
});

test("system events read as one sentence about who did what", () => {
  assert.equal(
    supportEventText({
      kind: "state_changed",
      actorName: "Desk",
      previousState: "open",
      nextState: "investigating",
    }),
    "Desk moved it from Open to Being looked at",
  );
  assert.equal(
    supportEventText({ kind: "owner_changed", actorName: "Priya", nextOwnerName: "Priya" }),
    "Priya took it",
  );
  assert.equal(
    supportEventText({ kind: "owner_changed", actorName: "Desk", nextOwnerName: "Priya" }),
    "Desk handed it to Priya",
  );
  assert.equal(
    supportEventText({ kind: "owner_changed", actorName: "Priya", previousOwnerName: "Priya" }),
    "Priya handed it back to the queue",
  );
  assert.equal(
    supportEventText({
      kind: "owner_changed",
      actorName: "Desk",
      previousOwnerName: "Priya",
      nextOwnerName: "Arjun",
    }),
    "Desk handed it from Priya to Arjun",
  );
  assert.equal(
    supportEventText({
      kind: "owner_changed",
      actorName: "Priya",
      previousOwnerName: "Priya",
      nextOwnerName: "Arjun",
    }),
    "Priya handed it to Arjun",
  );
});

test("audit reasons are derived from the update instead of typed by hand", () => {
  assert.equal(
    supportUpdateReason({ publicNote: true, internalNote: false, nextState: null }),
    "Help desk replied to the reporter",
  );
  assert.equal(
    supportUpdateReason({ publicNote: true, internalNote: false, nextState: "resolved" }),
    "Help desk replied to the reporter and moved it to resolved",
  );
  assert.equal(
    supportUpdateReason({ publicNote: true, internalNote: true, nextState: "waiting" }),
    "Help desk replied to the reporter, added a desk note and moved it to waiting on a reply",
  );
  assert.equal(supportOwnerReason({ kind: "claim" }), "Claimed at the help desk");
  assert.equal(
    supportOwnerReason({ kind: "handoff", displayName: "Priya Menon" }),
    "Handed to Priya Menon at the help desk",
  );
});


test("ages stay short enough for a list row", () => {
  assert.equal(formatSupportAge(now, now), "just now");
  assert.equal(formatSupportAge(now - 7 * minute, now), "7 min ago");
  assert.equal(formatSupportAge(now - 3 * 60 * minute, now), "3 h ago");
  assert.equal(formatSupportAge(now - 49 * 60 * minute, now), "2 days ago");
});
