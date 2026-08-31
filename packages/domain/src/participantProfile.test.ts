import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeParticipantName,
  normalizeParticipantPhone,
  participantNameValidationError,
  participantPhoneValidationError,
} from "./participantProfile.ts";

test("normalizes participant names without replacing the participant's spelling", () => {
  assert.equal(normalizeParticipantName("  Aditi   Rao  "), "Aditi Rao");
  assert.equal(participantNameValidationError("Aditi Rao"), null);
  assert.equal(participantNameValidationError("李 明"), null);
});

test("rejects obviously wrong participant names", () => {
  assert.match(participantNameValidationError("00000") ?? "", /two letters/u);
  assert.match(participantNameValidationError("person@example.com") ?? "", /not an email/u);
  assert.match(participantNameValidationError("Q") ?? "", /appear for the event/u);
});

test("normalizes Indian mobile numbers and keeps explicit international numbers", () => {
  assert.equal(normalizeParticipantPhone("98765 43210"), "+919876543210");
  assert.equal(normalizeParticipantPhone("+44 7700 900123"), "+447700900123");
  assert.equal(participantPhoneValidationError("+91 98765 43210"), null);
  assert.equal(participantPhoneValidationError("+44 7700 900123"), null);
});

test("rejects short and placeholder phone numbers", () => {
  assert.match(participantPhoneValidationError("00000") ?? "", /10 to 15 digits/u);
  assert.match(participantPhoneValidationError("1234") ?? "", /10 to 15 digits/u);
  assert.match(participantPhoneValidationError("0000000000") ?? "", /real phone number/u);
  assert.match(participantPhoneValidationError("1234567890") ?? "", /placeholder/u);
});
