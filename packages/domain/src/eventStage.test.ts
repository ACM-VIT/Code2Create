import assert from "node:assert/strict";
import test from "node:test";

import {
  type EventStage,
  activeWorkBlockerKeys,
  eventBlockerPaths,
  eventStageGuidance,
} from "./eventStage.ts";

const stages: EventStage[] = [
  "draft",
  "registration_open",
  "registration_closed",
  "live",
  "complete",
];

test("every stage says what it is for and which parts of the product it uses", () => {
  for (const stage of stages) {
    const guidance = eventStageGuidance[stage];
    assert.ok(guidance.label.length > 0, stage);
    assert.ok(guidance.goal.length > 0, stage);
    assert.ok(guidance.primaryPaths.length > 0, stage);
  }
});

test("stages chain forward to the end and then stop", () => {
  assert.equal(eventStageGuidance.draft.nextStatus, "registration_open");
  assert.equal(eventStageGuidance.registration_open.nextStatus, "registration_closed");
  assert.equal(eventStageGuidance.registration_closed.nextStatus, "live");
  assert.equal(eventStageGuidance.live.nextStatus, "complete");
  assert.equal(eventStageGuidance.complete.nextStatus, null);
  assert.equal(eventStageGuidance.complete.nextStep, null);
});

test("a stage with a next step always names it", () => {
  for (const stage of stages) {
    const guidance = eventStageGuidance[stage];
    assert.equal(
      guidance.nextStep === null,
      guidance.nextStatus === null,
      `${stage} must either have both a next step and a next state, or neither`,
    );
  }
});

test("setup keeps the operator out of event-day screens", () => {
  const setup = eventStageGuidance.draft.primaryPaths;
  for (const eventDayPath of ["/attendance", "/floor", "/reviews", "/scores", "/synesthesia"]) {
    assert.ok(!setup.includes(eventDayPath), `${eventDayPath} should not lead during setup`);
  }
});

test("the live event leads with the floor, not with configuration", () => {
  const live = eventStageGuidance.live.primaryPaths;
  assert.ok(live.includes("/attendance"));
  assert.ok(live.includes("/reviews"));
  assert.ok(!live.includes("/configuration"));
  assert.ok(!live.includes("/access"));
});

test("every blocker that setup can fix knows which screen fixes it", () => {
  const fixableKeys = [
    "event_dates",
    "participant_policy",
    "track_catalog",
    "intake_policy",
    "admission_policy",
    "communications_policy",
    "phase_schedule",
    "checkpoint_plan",
    "attendance_plan",
    "floor_plan",
    "review_round",
  ];
  for (const key of fixableKeys) {
    assert.ok(eventBlockerPaths[key], `${key} has no route`);
    assert.match(eventBlockerPaths[key] ?? "", /^\//);
  }
});

test("blockers that mean work is still running are not treated as setup", () => {
  for (const key of activeWorkBlockerKeys) {
    assert.equal(
      eventBlockerPaths[key],
      undefined,
      `${key} is work in progress, not a setting to publish`,
    );
  }
});
