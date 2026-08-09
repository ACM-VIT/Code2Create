import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEmergencyPackHtml,
  emergencyPackSerial,
  type EmergencyPackSnapshot,
} from "./emergencyPack.ts";

const snapshot: EmergencyPackSnapshot = {
  event: {
    name: "Code2Create 7.0",
    slug: "code2create-7",
    timezone: "Asia/Kolkata",
    status: "live",
    venue: "Main hall",
    version: 8,
  },
  snapshotAt: Date.UTC(2026, 7, 6, 1, 30),
  roster: [
    {
      participantReference: "member-1",
      name: "Ishaan <script>alert(1)</script>",
      phone: "+91 90000 00000",
      vitRegistrationNumber: "22BCE0001",
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      teamName: "Parallel Labs",
      teamCode: "C2C7ABC",
      teamStatus: "active",
      attendanceState: "inside",
      attendanceZoneName: "North hall",
      attendanceUpdatedAt: Date.UTC(2026, 7, 6, 1, 25),
      hallZoneName: "North",
      hallLocation: "North-east corner of North, near the windows",
    },
  ],
  sessions: [
    {
      id: "session-1",
      name: "Hacking session one",
      status: "open",
      requirement: "required",
      zoneId: "zone-1",
      zoneName: "North hall",
      startsAt: Date.UTC(2026, 7, 6, 0, 0),
      endsAt: Date.UTC(2026, 7, 6, 5, 0),
      expectationCount: 1,
      version: 3,
    },
  ],
  stations: [
    {
      id: "station-1",
      stableKey: "north-entry",
      name: "North entry",
      zoneId: "zone-1",
      zoneName: "North hall",
      status: "active",
      configurationVersion: 2,
      deviceName: "Scanner 4",
    },
  ],
  rounds: [
    {
      id: "round-1",
      name: "Intermediate review",
      status: "open",
      startsAt: Date.UTC(2026, 7, 6, 3, 0),
      endsAt: Date.UTC(2026, 7, 6, 6, 0),
      version: 5,
      rubricName: "Intermediate rubric",
      scoreMinimum: 0,
      scoreMaximum: 4,
      requiresSharedCommitments: true,
      criteria: [
        {
          id: "criterion-1",
          label: "Problem and value",
          question: "Does the team understand the problem?",
          displayOrder: 1,
        },
      ],
      panels: [
        {
          id: "panel-1",
          name: "Panel one",
          status: "ready",
          version: 2,
          coordinatorName: "Ananya Rao",
          reviewerNames: ["Ananya Rao", "Dev Mehta"],
        },
      ],
    },
  ],
};

test("uses manual-recovery-compatible unique sheet serials", () => {
  const attendance = emergencyPackSerial("A1B2C3D40011EEFF", "attendance", 1);
  const review = emergencyPackSerial("A1B2C3D40011EEFF", "review", 1);
  assert.equal(attendance, "C2C7-A1B2C3D40011EEFF-A-001");
  assert.equal(review, "C2C7-A1B2C3D40011EEFF-R-001");
  assert.notEqual(attendance, review);
  assert.match(attendance, /^[A-Z0-9][A-Z0-9._/-]{2,31}$/);
  assert.match(review, /^[A-Z0-9][A-Z0-9-]{2,39}$/);
});

test("builds the live snapshot and the requested numbered paper forms", () => {
  const result = buildEmergencyPackHtml({
    snapshot,
    purpose: "Venue network recovery rehearsal",
    expiresAt: snapshot.snapshotAt + 4 * 60 * 60 * 1_000,
    snapshotChecksum: "a".repeat(64),
    serialPrefix: "A1B2C3D40011EEFF",
    spareAttendanceSheetCount: 1,
    spareReviewSheetCount: 1,
  });

  assert.equal(result.attendanceSheetCount, 2);
  assert.equal(result.reviewSheetCount, 2);
  assert.match(result.html, /C2C7-A1B2C3D40011EEFF-A-001/);
  assert.match(result.html, /C2C7-A1B2C3D40011EEFF-A-002/);
  assert.match(result.html, /C2C7-A1B2C3D40011EEFF-R-001/);
  assert.match(result.html, /C2C7-A1B2C3D40011EEFF-R-002/);
  assert.match(result.html, /North entry/);
  assert.match(result.html, /Intermediate rubric/);
  assert.match(result.html, /Venue network recovery rehearsal/);
});

test("escapes identifiable and configuration text in the self-contained document", () => {
  const result = buildEmergencyPackHtml({
    snapshot,
    purpose: "Approved incident paper recovery",
    expiresAt: snapshot.snapshotAt + 60 * 60 * 1_000,
    snapshotChecksum: "b".repeat(64),
    serialPrefix: "0011AABB2233CCDD",
    spareAttendanceSheetCount: 0,
    spareReviewSheetCount: 0,
  });

  assert.doesNotMatch(result.html, /<script>alert\(1\)<\/script>/);
  assert.match(result.html, /Ishaan &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result.html, /<meta name="referrer" content="no-referrer">/);
  assert.match(result.html, /Content-Security-Policy/);
  assert.match(result.html, /noindex,nofollow,noarchive/);
});

test("always includes one blank form of each kind", () => {
  const result = buildEmergencyPackHtml({
    snapshot: { ...snapshot, stations: [], sessions: [], rounds: [] },
    purpose: "Prepared incident fallback forms",
    expiresAt: snapshot.snapshotAt + 60 * 60 * 1_000,
    snapshotChecksum: "c".repeat(64),
    serialPrefix: "11223344AABBCCDD",
    spareAttendanceSheetCount: 0,
    spareReviewSheetCount: 0,
  });

  assert.equal(result.attendanceSheetCount, 1);
  assert.equal(result.reviewSheetCount, 1);
  assert.match(result.html, /C2C7-11223344AABBCCDD-A-001/);
  assert.match(result.html, /C2C7-11223344AABBCCDD-R-001/);
});
