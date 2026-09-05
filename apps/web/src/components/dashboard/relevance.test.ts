import assert from "node:assert/strict";
import { test } from "node:test";

import { composeDashboard } from "./dashboardLayout.ts";
import type { ReviewTileModel } from "./ReviewTile";
import { tileRelevance, type DashboardModels } from "./relevance.ts";

const now = 1_000_000;
const quiet: DashboardModels = {
  event: { phases: [{ key: "build", name: "Build", startsAt: now - 1, endsAt: now + 10 * 60 * 60_000 }], now, timezone: "UTC" },
  music: { eligible: true, suspended: false, window: null, nowPlaying: null, queue: [], search: async () => [], request: async () => ({ created: true }), toggleVote: async () => {} },
  integrations: { available: true, github: { connected: false, detail: "", repositories: [] }, figma: { connected: false, detail: "" }, open: () => {} },
  updates: { available: true, checkpoints: [], timezone: "UTC", write: () => {} },
  review: null,
  queues: {
    available: true,
    services: [{ kind: "outing_permission", joined: false, position: null, waitingCount: 0 }],
    setServiceQueue: async () => {},
  },
  help: { discordUrl: null, support: null },
  benefits: { available: true, benefits: [] },
};

test("a quiet dashboard keeps the outing queue and the schedule on top", () => {
  const seating = composeDashboard(tileRelevance(quiet));
  assert.notEqual(seating.queues, undefined);
  assert.equal(seating.review, undefined);
  assert.equal(seating.event, "hero");
  assert.equal(Object.keys(seating).length, 7);
});

const review: ReviewTileModel = {
  round: "Midpoint review", state: "queued", paused: false, upNext: false,
  rank: 3, panel: "Panel 3", notice: null, estimate: null, now, session: null, showCode: null,
};

test("a queued team owns the hero while service queues remain separate", () => {
  const live: DashboardModels = {
    ...quiet,
    review,
    music: { ...quiet.music, window: { name: "w", endsAt: now + 1, requestsOpen: true, votingOpen: true, playbackPaused: false, requestsUsed: 0, requestsAllowed: 5, votesUsed: 0, votesAllowed: 10 } },
  };
  const seating = composeDashboard(tileRelevance(live));
  assert.equal(seating.review, "hero");
  assert.notEqual(seating.queues, undefined);
  assert.notEqual(seating.queues, seating.review);
  assert.equal(seating.benefits, undefined);
  assert.notEqual(seating.music, undefined);
});

test("reviewers arriving, discussion and scoring keep the hero without a queue rank", () => {
  for (const status of ["awaiting_presence", "active", "scoring"] as const) {
    const called: DashboardModels = {
      ...quiet,
      review: { ...review, state: status === "awaiting_presence" ? "called" : "in_review", rank: null, session: { status, present: 3, total: 5 } },
    };
    assert.equal(composeDashboard(tileRelevance(called)).review, "hero", status);
  }
});

test("a completed or withdrawn review gives the hero back to the event", () => {
  for (const state of ["completed", "withdrawn", "unassigned"] as const) {
    const seating = composeDashboard(tileRelevance({ ...quiet, review: { ...review, state, rank: null } }));
    assert.equal(seating.event, "hero", state);
    if (state !== "completed") assert.equal(seating.review, undefined, state);
  }
});

test("an outing queue never becomes a project review on build night", () => {
  const seating = composeDashboard(tileRelevance({
    ...quiet,
    queues: { ...quiet.queues, services: [{ kind: "outing_permission", joined: true, position: 3, waitingCount: 5 }] },
  }));
  assert.equal(seating.event, "hero");
  assert.equal(seating.review, undefined);
  assert.notEqual(seating.queues, undefined);
});

test("reviews remain visible when paused or needing help, ahead of a phase change", () => {
  for (const state of ["queued", "held", "missed"] as const) {
    const seating = composeDashboard(tileRelevance({
      ...quiet,
      event: { ...quiet.event, phases: [{ key: "build", name: "Build", startsAt: now - 1, endsAt: now + 1 }] },
      review: { ...review, state, paused: true },
    }));
    assert.equal(seating.review, "hero", state);
  }
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
