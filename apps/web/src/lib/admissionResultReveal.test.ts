import assert from "node:assert/strict";
import test from "node:test";

import {
  admissionResultOutcome,
  admissionResultRevealKey,
  admissionResultUsesChest,
} from "./admissionResultReveal.ts";

test("reveals every published admission decision with the right outcome", () => {
  assert.equal(admissionResultOutcome("accepted"), "selected");
  assert.equal(admissionResultOutcome("offer_sent"), "selected");
  assert.equal(admissionResultOutcome("confirmed"), "selected");
  assert.equal(admissionResultOutcome("waitlisted"), "waitlisted");
  assert.equal(admissionResultOutcome("declined"), "not_selected");
});

test("does not treat workflow or later RSVP states as new result announcements", () => {
  assert.equal(admissionResultOutcome("submitted"), null);
  assert.equal(admissionResultOutcome("under_review"), null);
  assert.equal(admissionResultOutcome("offer_expired"), null);
  assert.equal(admissionResultOutcome("withdrawn"), null);
});

test("reserves the chest animation for selected teams", () => {
  assert.equal(admissionResultUsesChest("selected"), true);
  assert.equal(admissionResultUsesChest("waitlisted"), false);
  assert.equal(admissionResultUsesChest("not_selected"), false);
});

test("keeps one reveal receipt across accepted offer lifecycle transitions", () => {
  const applicationId = "application-7";
  const accepted = admissionResultOutcome("accepted");
  const offered = admissionResultOutcome("offer_sent");

  assert.ok(accepted);
  assert.ok(offered);
  assert.equal(
    admissionResultRevealKey(applicationId, accepted),
    admissionResultRevealKey(applicationId, offered),
  );
});
