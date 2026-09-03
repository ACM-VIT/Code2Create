import assert from "node:assert/strict";
import { test } from "node:test";

import { composeDashboard } from "./dashboardLayout.ts";
import { tileRelevance, type DashboardModels } from "./relevance.ts";

const now = 1_000_000;
const quiet: DashboardModels = {
  event: { phases: [{ key: "build", name: "Build", startsAt: now - 1, endsAt: now + 10 * 60 * 60_000 }], now, timezone: "UTC" },
  music: { eligible: true, suspended: false, window: null, nowPlaying: null, queue: [], search: async () => [], request: async () => ({ created: true }), toggleVote: async () => {} },
  integrations: { available: true, idea: "A calm coordination layer for crowded live events.", github: { connected: false, detail: "" }, figma: { connected: false, detail: "" }, open: () => {} },
  updates: { available: true, checkpoints: [], timezone: "UTC", write: () => {} },
  review: { available: true, queue: null, showCode: null },
  help: { discordUrl: null, support: null },
  benefits: { available: true, benefits: [] },
};

test("a quiet dashboard drops the review tile and keeps the schedule on top", () => {
  const seating = composeDashboard(tileRelevance(quiet));
  assert.equal(seating.review, undefined);
  assert.equal(seating.event, "hero");
  assert.equal(Object.keys(seating).length, 7);
});

test("an open review stays visible without displacing the project from its top-right box", () => {
  const live: DashboardModels = {
    ...quiet,
    review: { available: true, queue: { round: "R1", state: "In queue", detail: null, wait: null, reviewers: null }, showCode: { sessionId: "review-session", mint: async () => ({ payload: "", manualCode: "", expiresAt: 0, serverNow: 0 }) } },
    music: { ...quiet.music, window: { name: "w", endsAt: now + 1, requestsOpen: true, votingOpen: true, playbackPaused: false, requestsUsed: 0, requestsAllowed: 5, votesUsed: 0, votesAllowed: 10 } },
  };
  const seating = composeDashboard(tileRelevance(live));
  assert.equal(seating.integrations, "blossom");
  assert.equal(seating.review, "garden");
  assert.equal(seating.benefits, undefined);
  assert.notEqual(seating.music, undefined);
});

test("a phase boundary within the hour lifts the event tile, an open checkpoint lifts updates", () => {
  const busy: DashboardModels = {
    ...quiet,
    event: { ...quiet.event, phases: [{ key: "build", name: "Build", startsAt: now - 1, endsAt: now + 30 * 60_000 }] },
    updates: { ...quiet.updates, checkpoints: [{ key: "mid", name: "Mid", state: "open", opensAt: now - 1, dueAt: now + 1 }] },
  };
  const scores = Object.fromEntries(tileRelevance(busy).map((entry) => [entry.key, entry.score]));
  assert.equal(scores.event, 95);
  assert.equal(scores.updates, 92);
});
