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
    available: true, pending: false,
    services: [{ kind: "outing_permission", status: "available", position: null, waitingCount: 0, capacity: 15, occupiedCount: 0, permissionExpiresAt: null, returnBy: null, serverNow: now, canRequest: true }],
    setServiceQueue: async () => {},
  },
  help: { discordUrl: null, support: null },
  benefits: { available: true, benefits: [] },
};

test("a quiet dashboard keeps the outing queue and the schedule on top", () => {
  const seating = composeDashboard(tileRelevance(quiet));
  assert.notEqual(seating.queues, undefined);
  assert.equal(seating.review, undefined);
  assert.equal(seating.benefits, undefined);
  assert.equal(seating.event, "hero");
  assert.equal(Object.keys(seating).length, 7);
});

test("empty and unavailable benefits never occupy a dashboard seat", () => {
  for (const available of [false, true]) {
    const candidates = tileRelevance({ ...quiet, benefits: { available, benefits: [] } });
    assert.equal(candidates.some((candidate) => candidate.key === "benefits"), false);
    assert.equal(composeDashboard(candidates).benefits, undefined);
  }
});

const perk = { id: "perk-1", name: "Team credit", scope: "team" as const, code: "TEST-CREDIT" };

test("benefits appear when issued and disappear when the last benefit is removed", () => {
  const withBenefits = { ...quiet, benefits: { available: true, benefits: [perk] } };
  assert.notEqual(composeDashboard(tileRelevance(withBenefits)).benefits, undefined);
  assert.equal(composeDashboard(tileRelevance(quiet)).benefits, undefined);
  assert.equal(composeDashboard(tileRelevance({
    ...withBenefits, benefits: { available: false, benefits: [perk] },
  })).benefits, undefined);
});

test("issued benefits replace Help even with an open support conversation", () => {
  const withSupport = { ...quiet, help: { ...quiet.help, support: { open: 1 } } };
  for (const currentReview of [null, review]) {
    const candidates = tileRelevance({
      ...withSupport, review: currentReview, benefits: { available: true, benefits: [perk] },
    });
    assert.equal(candidates.some(candidate => candidate.key === "help"), false);
    assert.equal(candidates.find(candidate => candidate.key === "benefits")?.required, true);
    const seating = composeDashboard(candidates);
    assert.notEqual(seating.benefits, undefined);
    assert.notEqual(seating.queues, undefined);
    assert.equal(seating.help, undefined);
  }
  assert.notEqual(composeDashboard(tileRelevance(withSupport)).help, undefined);
  assert.notEqual(composeDashboard(tileRelevance({
    ...withSupport, benefits: { available: false, benefits: [perk] },
  })).help, undefined);
});

test("request queues remain visible with no open services or while unavailable", () => {
  for (const available of [false, true]) {
    const seating = composeDashboard(tileRelevance({
      ...quiet, queues: { ...quiet.queues, available, services: [] },
    }));
    assert.notEqual(seating.queues, undefined);
    assert.equal(seating.benefits, undefined);
    assert.equal(Object.keys(seating).length, 7);
  }
});

const review: ReviewTileModel = {
  round: "Midpoint review", state: "queued", paused: false, upNext: false,
  rank: 3, panel: "Panel 3", notice: null, estimate: null, now, session: null, showCode: null,
};

test("a closed request queue cannot be displaced by reviews, benefits, or other busy tiles", () => {
  const seating = composeDashboard(tileRelevance({
    ...quiet,
    review,
    queues: { ...quiet.queues, services: [] },
    benefits: { available: true, benefits: [perk] },
    updates: { ...quiet.updates, checkpoints: [{ key: "idea", name: "Idea", state: "open", opensAt: now - 1, dueAt: now + 1 }] },
    help: { ...quiet.help, support: { open: 2 } },
  }));
  assert.notEqual(seating.queues, undefined);
  assert.notEqual(seating.benefits, undefined);
  assert.equal(seating.review, "hero");
  assert.equal(Object.keys(seating).length, 7);
});

test("a queued team owns the hero while service queues remain separate", () => {
  const live: DashboardModels = {
    ...quiet,
    review,
    music: { ...quiet.music, window: { name: "w", endsAt: now + 1, requestsOpen: true, votingOpen: true, playbackPaused: false, requestsUsed: 0, requestsAllowed: 5, votesUsed: 0 } },
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
    queues: { ...quiet.queues, services: [{ ...quiet.queues.services[0]!, status: "waiting", position: 3, waitingCount: 5 }] },
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
