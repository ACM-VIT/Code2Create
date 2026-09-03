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
  for (const eventDayPath of ["/attendance", "/reviews", "/scores", "/synesthesia"]) {
    assert.ok(!setup.includes(eventDayPath), `${eventDayPath} should not lead during setup`);
  }
});

test("the live event leads with event-day work, not configuration", () => {
  const live = eventStageGuidance.live.primaryPaths;
  assert.ok(live.includes("/attendance"));
  assert.ok(live.includes("/reviews"));
  assert.ok(!live.includes("/configuration"));
  assert.ok(!live.includes("/access"));
});

test("every lifecycle blocker knows which product screen resolves it", () => {
  const blockerKeys = [
    "active_attendance_session",
    "active_review_round",
    "event_dates",
    "future_application_deadline",
    "participant_policy",
    "intake_policy",
    "admission_policy",
    "communications_policy",
    "integration_policy",
    "phase_schedule",
    "checkpoint_plan",
    "attendance_plan",
    "review_round",
  ];
  for (const key of blockerKeys) {
    const path = eventBlockerPaths[key];
    assert.ok(path !== undefined && path.length > 0, `${key} has no route`);
    assert.match(eventBlockerPaths[key] ?? "", /^\//);
  }
});

test("active work blockers open their live control rooms", () => {
  assert.deepEqual(activeWorkBlockerKeys, ["active_attendance_session", "active_review_round"]);
  assert.equal(eventBlockerPaths.active_attendance_session, "/attendance");
  assert.equal(eventBlockerPaths.active_review_round, "/reviews");
});
