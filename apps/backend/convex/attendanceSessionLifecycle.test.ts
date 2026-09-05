import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { requireParticipantAttendanceHistoryPageSize } from "./attendanceRemedies.ts";
import { attendanceCounterShardFor } from "./lib/attendanceCounters.ts";
import {
  attendanceSessionCutoffAt,
  attendanceSessionWindowRejection,
  extendedAttendanceSessionTiming,
} from "./lib/attendanceSessionLifecycle.ts";
import {
  maximumAttendanceIntervalsPerParticipantSession,
  prepareSessionTransition,
} from "./lib/attendanceSessionTransition.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("attendance session lifecycle", () => {
  test("extension advances accepted end and late-arrival close together", () => {
    const session = {
      checkInOpensAt: 100,
      checkInClosesAt: 800,
      endsAt: 1_000,
    };

    expect(
      extendedAttendanceSessionTiming({
        session,
        extensionMinutes: 30,
        now: 900,
        eventEndsAt: 2_000_000,
      }),
    ).toEqual({
      checkInClosesAt: 1_800_800,
      endsAt: 1_801_000,
    });
    expect(() =>
      extendedAttendanceSessionTiming({
        session,
        extensionMinutes: 30,
        now: 1_001,
      }),
    ).toThrow("cannot be extended retroactively");
    expect(() =>
      extendedAttendanceSessionTiming({
        session,
        extensionMinutes: 30,
        now: 900,
        eventEndsAt: 1_800_999,
      }),
    ).toThrow("within the event window");
  });

  test("accepted cutoff never grows because an operator closes late", () => {
    expect(attendanceSessionCutoffAt({ endsAt: 10_000 }, 9_000)).toBe(9_000);
    expect(attendanceSessionCutoffAt({ endsAt: 10_000 }, 12_000)).toBe(10_000);
  });

  test("late-arrival close does not block an already-confirmed exit or return", () => {
    const session = {
      checkInOpensAt: 100,
      checkInClosesAt: 700,
      endsAt: 1_000,
    };
    expect(
      attendanceSessionWindowRejection({ session, transition: "session_confirm", now: 800 }),
    ).toBe("outside_check_in_window");
    expect(
      attendanceSessionWindowRejection({ session, transition: "zone_entry", now: 800 }),
    ).toBeNull();
    expect(attendanceSessionWindowRejection({ session, transition: "zone_exit", now: 1_001 })).toBe(
      "outside_session_window",
    );
  });

  test("cancellation closes projections at one cutoff without editing scan history", async () => {
    const now = Date.UTC(2027, 7, 8, 12, 0, 0);
    const cutoffAt = now - 5 * 60_000;
    const openedAt = cutoffAt - 25 * 60_000;
    const backend = convexTest(schema, modules);
    const fixture = await seedCancellationFixture(backend, {
      now,
      cutoffAt,
      openedAt,
    });
    const eventBefore = await backend.run((ctx) => ctx.db.get(fixture.presenceEventId));

    await backend.mutation(internal.attendanceSessions.cancelResultBatch, {
      jobId: fixture.jobId,
    });

    const state = await backend.run(async (ctx) => {
      const [session, participant, interval, job, counter, presenceEvent, projection] =
        await Promise.all([
          ctx.db.get(fixture.sessionId),
          ctx.db.get(fixture.participantId),
          ctx.db.get(fixture.intervalId),
          ctx.db.get(fixture.jobId),
          ctx.db
            .query("attendanceSessionCounterShards")
            .withIndex("by_session_shard", (index) =>
              index.eq("sessionId", fixture.sessionId).eq("shard", fixture.shard),
            )
            .unique(),
          ctx.db.get(fixture.presenceEventId),
          ctx.db
            .query("attendanceParticipantCurrentSessions")
            .withIndex("by_session_membership", (index) =>
              index.eq("sessionId", fixture.sessionId).eq("membershipId", fixture.membershipId),
            )
            .unique(),
        ]);
      return { session, participant, interval, job, counter, presenceEvent, projection };
    });

    expect(state.session).toMatchObject({
      status: "cancelled",
      cancelledAt: cutoffAt,
      version: 5,
    });
    expect(state.participant).toMatchObject({
      state: "complete",
      result: "not_expected",
      presentDurationMs: cutoffAt - openedAt,
      completedAt: cutoffAt,
      version: 2,
    });
    expect(state.participant?.currentIntervalId).toBeUndefined();
    expect(state.interval).toMatchObject({ status: "closed", closedAt: cutoffAt });
    expect(state.job).toMatchObject({ status: "complete", scannedCount: 1, affectedCount: 1 });
    expect(state.counter).toMatchObject({ present: 0, complete: 1, expected: 1, version: 2 });
    expect(state.presenceEvent).toEqual(eventBefore);
    expect(state.projection).toBeNull();
  });

  test("terminalization fails without consuming a source row when its projection is missing", async () => {
    const now = Date.UTC(2027, 7, 8, 13, 0, 0);
    const cutoffAt = now - 5 * 60_000;
    const openedAt = cutoffAt - 25 * 60_000;
    const backend = convexTest(schema, modules);
    const fixture = await seedCancellationFixture(backend, { now, cutoffAt, openedAt });
    await backend.run(async (ctx) => {
      const projection = await ctx.db
        .query("attendanceParticipantCurrentSessions")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", fixture.sessionId).eq("membershipId", fixture.membershipId),
        )
        .unique();
      if (!projection) throw new Error("Expected participant projection fixture.");
      await ctx.db.delete(projection._id);
    });

    await backend.mutation(internal.attendanceSessions.cancelResultBatch, {
      jobId: fixture.jobId,
    });

    const state = await backend.run(async (ctx) => ({
      participant: await ctx.db.get(fixture.participantId),
      job: await ctx.db.get(fixture.jobId),
    }));
    expect(state.job).toMatchObject({
      status: "failed",
      failureCode: "participant_projection_incomplete",
    });
    expect(state.participant).toMatchObject({
      state: "present",
      version: 1,
    });
    expect(state.participant?.completedAt).toBeUndefined();
  });

  test("participant result history rejects unbounded pages", () => {
    expect(() => requireParticipantAttendanceHistoryPageSize(0)).toThrow("between 1 and 10");
    expect(() => requireParticipantAttendanceHistoryPageSize(10)).not.toThrow();
    expect(() => requireParticipantAttendanceHistoryPageSize(11)).toThrow("between 1 and 10");
  });

  test("a participant cannot create an unbounded session interval history", async () => {
    const now = Date.UTC(2027, 7, 8, 14, 0, 0);
    const cutoffAt = now - 5 * 60_000;
    const openedAt = cutoffAt - 25 * 60_000;
    const backend = convexTest(schema, modules);
    const fixture = await seedCancellationFixture(backend, { now, cutoffAt, openedAt });
    const decision = await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.intervalId, {
        status: "closed",
        closedByEventId: fixture.presenceEventId,
        closedAt: openedAt + 1,
      });
      await ctx.db.patch(fixture.participantId, {
        state: "temporarily_out",
        currentIntervalId: undefined,
      });
      for (let index = 1; index < maximumAttendanceIntervalsPerParticipantSession; index += 1) {
        await ctx.db.insert("attendancePresenceIntervals", {
          eventId: fixture.eventId,
          membershipId: fixture.membershipId,
          zoneId: fixture.zoneId,
          sessionId: fixture.sessionId,
          kind: "session",
          status: "closed",
          openedByEventId: fixture.presenceEventId,
          openedAt: openedAt + index * 2,
          closedByEventId: fixture.presenceEventId,
          closedAt: openedAt + index * 2 + 1,
        });
      }
      const participant = await ctx.db.get(fixture.participantId);
      if (!participant) throw new Error("Expected attendance participant fixture.");
      return (
        await prepareSessionTransition(ctx, {
          participant,
          transition: "zone_entry",
        })
      ).decision;
    });

    expect(decision).toMatchObject({
      outcome: "needs_review",
      reasonCode: "session_interval_limit_reached",
      nextState: "needs_review",
    });
  });
});

async function seedCancellationFixture(
  backend: BackendTest,
  timing: { now: number; cutoffAt: number; openedAt: number },
) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `attendance-session-${timing.now}`,
      name: "Attendance session fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: timing.openedAt - 30 * 60_000,
      endsAt: timing.now + 60 * 60_000,
      version: 1,
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `attendance-session-user-${timing.now}`,
      googleSubject: `attendance-session-subject-${timing.now}`,
      verifiedEmail: `attendance-session-${timing.now}@example.test`,
      displayName: "Attendance fixture person",
      status: "active",
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `attendance-session-${timing.now}@example.test`,
      displayName: "Attendance fixture person",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    const planVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId,
      version: 1,
      name: "Fixture plan",
      vitBarcodeSymbologies: ["code128"],
      vitBarcodeNormalizationVersion: "trim-v1",
      offlineQueueMaxScans: 8,
      offlineQueueMaxAgeSeconds: 180,
      status: "published",
      checksum: "fixture-plan",
      createdByPersonId: personId,
      createdAt: timing.now,
      publishedAt: timing.now,
    });
    const zoneId = await ctx.db.insert("attendanceZones", {
      eventId,
      planVersionId,
      stableKey: "fixture_zone",
      name: "Fixture zone",
      createdAt: timing.now,
    });
    const sessionId = await ctx.db.insert("attendanceSessions", {
      eventId,
      planVersionId,
      stableKey: "fixture_session",
      name: "Fixture session",
      kind: "hacking",
      requirement: "required",
      expectedCohort: { kind: "all_admitted" },
      zoneId,
      status: "closing",
      startsAt: timing.openedAt - 30 * 60_000,
      endsAt: timing.cutoffAt,
      checkInOpensAt: timing.openedAt - 35 * 60_000,
      checkInClosesAt: timing.cutoffAt,
      expectationBuildState: "complete",
      expectationCount: 1,
      version: 4,
      openedAt: timing.openedAt,
      closingCutoffAt: timing.cutoffAt,
      cancelledByPersonId: personId,
      cancellationReason: "Venue session cancelled for fixture",
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    const presenceEventId = await ctx.db.insert("attendancePresenceEvents", {
      eventId,
      sourceKind: "scanner",
      zoneId,
      sessionId,
      operatorPersonId: personId,
      membershipId,
      credentialKind: "external_pass",
      clientOperationId: `fixture-scan-${timing.now}`,
      requestFingerprint: "fixture-scan",
      capturedAt: timing.openedAt,
      receivedAt: timing.openedAt,
      isOfflineReplay: false,
      transition: "session_confirm",
      outcome: "accepted",
      reasonCode: "session_presence_recorded",
      previousState: "confirmation_due",
      nextState: "present",
    });
    const intervalId = await ctx.db.insert("attendancePresenceIntervals", {
      eventId,
      membershipId,
      zoneId,
      sessionId,
      kind: "session",
      status: "open",
      openedByEventId: presenceEventId,
      openedAt: timing.openedAt,
    });
    const participantId = await ctx.db.insert("attendanceSessionParticipants", {
      eventId,
      sessionId,
      membershipId,
      expectation: "required",
      state: "present",
      confirmedAt: timing.openedAt,
      late: false,
      currentIntervalId: intervalId,
      lastEventId: presenceEventId,
      version: 1,
      updatedAt: timing.openedAt,
    });
    await ctx.db.insert("attendanceParticipantCurrentSessions", {
      eventId,
      planVersionId,
      sessionId,
      sessionParticipantId: participantId,
      membershipId,
      sessionStartsAt: timing.openedAt - 30 * 60_000,
      createdAt: timing.now,
    });
    const shard = attendanceCounterShardFor(membershipId);
    await ctx.db.insert("attendanceSessionCounterShards", {
      eventId,
      sessionId,
      shard,
      expected: 1,
      confirmationDue: 0,
      present: 1,
      temporarilyOut: 0,
      complete: 0,
      excused: 0,
      needsReview: 0,
      late: 0,
      version: 1,
      updatedAt: timing.openedAt,
    });
    const jobId = await ctx.db.insert("attendanceSessionJobs", {
      eventId,
      sessionId,
      kind: "cancel_results",
      status: "queued",
      scannedCount: 0,
      affectedCount: 0,
      requestedByPersonId: personId,
      clientOperationId: `fixture-cancel-${timing.now}`,
      createdAt: timing.now,
      updatedAt: timing.now,
    });
    await ctx.db.patch(sessionId, { finalizationJobId: jobId });
    return {
      eventId,
      sessionId,
      zoneId,
      participantId,
      membershipId,
      intervalId,
      presenceEventId,
      jobId,
      shard,
    } satisfies {
      eventId: Id<"events">;
      sessionId: Id<"attendanceSessions">;
      zoneId: Id<"attendanceZones">;
      participantId: Id<"attendanceSessionParticipants">;
      membershipId: Id<"eventMemberships">;
      intervalId: Id<"attendancePresenceIntervals">;
      presenceEventId: Id<"attendancePresenceEvents">;
      jobId: Id<"attendanceSessionJobs">;
      shard: number;
    };
  });
}
