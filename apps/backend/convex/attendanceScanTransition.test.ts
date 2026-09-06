import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import aggregateTest from "@convex-dev/aggregate/test";
import { insertParticipantServiceQueueEntry } from "./lib/participantServiceQueue";
import { afterAll, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import {
  attendanceCounterShardFor,
  moveSessionCounter,
  moveZoneCounter,
} from "./lib/attendanceCounters.ts";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability.ts";
import { stationAssignmentSourceId } from "./lib/attendanceStations.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedScannerFixture>>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";

afterAll(() => {
  if (originalAuthSiteUrl === undefined) delete process.env.AUTH_SITE_URL;
  else process.env.AUTH_SITE_URL = originalAuthSiteUrl;
});

describe("attendance scan direction", () => {
  test.each([
    { onboardingStatus: "submitted", eligibilityStatus: "eligible" },
    { onboardingStatus: "selected", eligibilityStatus: "eligible" },
    { onboardingStatus: "offer_pending", eligibilityStatus: "eligible" },
    { onboardingStatus: "accepted", eligibilityStatus: "rejected" },
    { onboardingStatus: "accepted", eligibilityStatus: "suspended" },
  ] as const)(
    "rejects $onboardingStatus / $eligibilityStatus participants online and on replay",
    async ({ onboardingStatus, eligibilityStatus }) => {
      const backend = seededBackend();
      const fixture = await seedScannerFixture(backend);
      const operator = asOperator(backend, fixture);
      await backend.run((ctx) =>
        ctx.db.patch(fixture.membershipId, { onboardingStatus, eligibilityStatus }),
      );

      for (const isOfflineReplay of [false, true]) {
        const receipt = await operator.mutation(internal.attendanceScan.recordScan, {
          ...scanArguments(fixture),
          rovingTransition: "venue_entry",
          clientOperationId: `unaccepted-entry-${isOfflineReplay}`,
          deviceSequence: isOfflineReplay ? 2 : 1,
          isOfflineReplay,
        });
        expect(receipt).toMatchObject({
          outcome: "rejected",
          reasonCode: "participant_not_active",
        });
        const presenceEvent = await backend.run((ctx) => ctx.db.get(receipt.presenceEventId));
        expect(presenceEvent).toMatchObject({
          membershipId: fixture.membershipId,
          outcome: "rejected",
          isOfflineReplay,
        });
      }

      const presence = await backend.run(async (ctx) => ({
        venueState: await ctx.db.query("attendanceVenueStates").first(),
        interval: await ctx.db.query("attendancePresenceIntervals").first(),
      }));
      expect(presence).toEqual({ venueState: null, interval: null });
    },
  );

  test("a fixed venue station derives its transition and rejects a client override", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    await backend.run((ctx) => ctx.db.patch(fixture.stationId, { mode: "venue_entry" }));

    const entry = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      clientOperationId: "fixed-entry",
      deviceSequence: 1,
    });
    expect(entry).toMatchObject({ outcome: "accepted", transition: "venue_entry" });

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        rovingTransition: "venue_exit",
        clientOperationId: "fixed-override",
        deviceSequence: 2,
      }),
    ).rejects.toThrow("transition is fixed");
  });

  test("automatic presence requires a staffed check-in", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const result = await asOperator(backend, fixture).mutation(
      internal.attendanceScan.recordScan,
      {
        ...scanArguments(fixture),
        clientOperationId: "roving-without-checkin",
        deviceSequence: 1,
      },
    );
    expect(result).toMatchObject({
      outcome: "rejected",
      reasonCode: "staffed_check_in_required",
    });
    expect(
      await backend.run((ctx) => ctx.db.query("attendanceVenueStates").first()),
    ).toBeNull();
  });

  test("washroom scans clear the queue on departure and safely record return", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    await seedCheckIn(backend, fixture);
    await backend.run(async (ctx) => {
      const member = await ctx.db.get(fixture.membershipId);
      if (!member) throw new Error("Missing fixture participant");
      await insertParticipantServiceQueueEntry(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        personId: member.personId,
        kind: "outing_permission",
        joinedAt: fixture.now,
      });
    });
    expect(
      await operator.query(api.serviceQueues.forStation, {
        eventSlug: fixture.eventSlug,
        stationId: fixture.stationId,
      }),
    ).toMatchObject({ waitingCount: 1 });
    const request = {
      ...scanArguments(fixture),
      clientOperationId: "automatic-departure",
      deviceSequence: 1,
    };
    const departure = await operator.mutation(
      internal.attendanceScan.recordScan,
      request,
    );
    expect(departure).toMatchObject({
      outcome: "accepted",
      transition: "venue_exit",
      nextState: "temporarily_out",
    });
    expect(
      await operator.query(api.serviceQueues.forStation, {
        eventSlug: fixture.eventSlug,
        stationId: fixture.stationId,
      }),
    ).toEqual({ waitingCount: 0, next: [] });
    expect(
      await operator.mutation(internal.attendanceScan.recordScan, {
        ...request,
        isOfflineReplay: true,
      }),
    ).toEqual(departure);
    expect(
      await operator.mutation(internal.attendanceScan.recordScan, {
        ...request,
        clientOperationId: "second-camera-decode",
        deviceSequence: 2,
      }),
    ).toMatchObject({ outcome: "duplicate", nextState: "temporarily_out" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixture.now + 20_000);
    try {
      const back = await operator.mutation(internal.attendanceScan.recordScan, {
        ...request,
        capturedAt: Date.now(),
        clientOperationId: "automatic-return",
        deviceSequence: 3,
      });
      expect(back).toMatchObject({
        outcome: "accepted",
        transition: "venue_entry",
        nextState: "inside",
      });
      expect(
        await backend.run((ctx) =>
          ctx.db.query("attendancePresenceIntervals").first(),
        ),
      ).toMatchObject({ kind: "venue", status: "open" });
    } finally {
      clock.mockRestore();
    }
  });

  test("automatic movement is never guessed from an unsent offline scan", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    await seedCheckIn(backend, fixture);
    await expect(
      asOperator(backend, fixture).mutation(
        internal.attendanceScan.recordScan,
        {
          ...scanArguments(fixture),
          clientOperationId: "offline-automatic",
          deviceSequence: 1,
          isOfflineReplay: true,
        },
      ),
    ).rejects.toThrow("live connection");
    expect(
      await backend.run((ctx) => ctx.db.query("attendanceVenueStates").first()),
    ).toBeNull();
  });

  test("external physical cards resolve only through their active binding", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    await seedCheckIn(backend, fixture);
    const operator = asOperator(backend, fixture);
    const request = {
      ...scanArguments(fixture),
      credentialKind: "external_id_barcode" as const,
      lookupHash: "external-card-hmac",
      deviceSequence: 1,
      clientOperationId: "unlinked-card",
    };
    expect(
      await operator.mutation(internal.attendanceScan.recordScan, request),
    ).toMatchObject({
      outcome: "rejected",
      reasonCode: "external_id_not_linked",
    });
    const bindingId = await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.membershipId, {
        participantClass: "external_participant",
      });
      return ctx.db.insert("attendanceExternalIdentityBindings", {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        lookupHash: request.lookupHash,
        barcodeSymbology: "code128",
        version: 1,
        state: "active",
        linkedByPersonId: fixture.operatorPersonId,
        linkedAt: fixture.now,
        updatedAt: fixture.now,
      });
    });
    expect(
      await operator.mutation(internal.attendanceScan.recordScan, {
        ...request,
        clientOperationId: "linked-card",
        deviceSequence: 2,
      }),
    ).toMatchObject({
      outcome: "accepted",
      transition: "venue_exit",
      participant: { membershipId: fixture.membershipId },
    });
    await backend.run((ctx) => ctx.db.patch(bindingId, { state: "suspended" }));
    expect(
      await operator.mutation(internal.attendanceScan.recordScan, {
        ...request,
        clientOperationId: "suspended-card",
        deviceSequence: 3,
      }),
    ).toMatchObject({
      outcome: "rejected",
      reasonCode: "external_id_not_linked",
    });
  });

  test("configures an unused washroom station without changing an active check-in phone", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const stationId = await backend.run(async (ctx) => {
      const source = await ctx.db.get(fixture.stationId);
      if (!source) throw new Error("Missing fixture station");
      const {
        _id: _stationId,
        _creationTime: _createdAt,
        deviceInstallationId: _deviceId,
        ...station
      } = source;
      return ctx.db.insert("attendanceStations", {
        ...station,
        stableKey: "unused_phone",
        status: "inactive",
        mode: "venue_entry",
      });
    });
    const request = {
      eventSlug: fixture.eventSlug,
      stationId,
      expectedConfigurationVersion: 1,
      mode: "roving" as const,
      name: "Washroom 1",
      reason: "Configure the washroom scanner",
      clientOperationId: "configure-washroom-phone",
    };
    await expect(
      operator.mutation(
        api.attendanceSecurity.configurePresenceStation,
        request,
      ),
    ).rejects.toThrow();
    await backend.run(async (ctx) => {
      const subject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("personId", fixture.operatorPersonId),
        )
        .unique();
      if (!subject) throw new Error("Missing operator");
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.station.manage",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "fixture",
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Configure test stations",
      });
    });
    const changed = await operator.mutation(
      api.attendanceSecurity.configurePresenceStation,
      request,
    );
    expect(changed).toEqual({ stationId, configurationVersion: 2 });
    expect(
      await operator.mutation(
        api.attendanceSecurity.configurePresenceStation,
        request,
      ),
    ).toEqual(changed);
    await expect(
      operator.mutation(api.attendanceSecurity.configurePresenceStation, {
        ...request,
        clientOperationId: "stale-configuration",
      }),
    ).rejects.toThrow("configuration changed");
    await expect(
      operator.mutation(api.attendanceSecurity.configurePresenceStation, {
        ...request,
        stationId: fixture.stationId,
        clientOperationId: "occupied-configuration",
      }),
    ).rejects.toThrow("unused");
    expect(
      await backend.run((ctx) => ctx.db.get(fixture.stationId)),
    ).toMatchObject({
      status: "active",
      configurationVersion: 1,
      deviceInstallationId: fixture.deviceInstallationId,
    });
  });

  test("a station rejects a credential method outside its allowlist", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.stationId, {
        mode: "venue_entry",
        allowedCredentialKinds: ["badge_qr"],
      }),
    );

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        clientOperationId: "disallowed-credential",
        deviceSequence: 1,
      }),
    ).rejects.toThrow("credential method is not enabled");
  });

  test("one station records a participant arriving and then leaving", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);

    const entry = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "venue_entry",
      clientOperationId: "scan-entry",
      deviceSequence: 1,
    });
    expect(entry).toMatchObject({
      outcome: "accepted",
      reasonCode: "venue_entry_recorded",
      transition: "venue_entry",
      previousState: "not_arrived",
      nextState: "inside",
    });

    const exit = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "venue_exit",
      clientOperationId: "scan-exit",
      deviceSequence: 2,
    });
    expect(exit).toMatchObject({
      outcome: "accepted",
      reasonCode: "venue_exit_recorded",
      transition: "venue_exit",
      previousState: "inside",
      nextState: "temporarily_out",
    });

    const station = await backend.run((ctx) => ctx.db.get(fixture.stationId));
    expect(station?.configurationVersion).toBe(1);
  });

  test("a session scan resolves the session bound to the station", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const sessionId = await openSession(backend, fixture);
    const otherSessionId = await insertOpenSession(backend, fixture, {
      stableKey: "overlapping_session",
      bindStation: false,
    });
    await backend.run((ctx) => ctx.db.patch(fixture.stationId, { mode: "session_confirm" }));

    const receipt = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      clientOperationId: "scan-session",
      deviceSequence: 1,
    });

    expect(receipt).toMatchObject({
      outcome: "accepted",
      reasonCode: "session_presence_recorded",
      transition: "session_confirm",
      previousState: "confirmation_due",
      nextState: "present",
    });
    const presenceEvent = await backend.run((ctx) =>
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_operator_operation", (index) =>
          index
            .eq("operatorPersonId", fixture.operatorPersonId)
            .eq("clientOperationId", "scan-session"),
        )
        .unique(),
    );
    expect(presenceEvent?.sessionId).toBe(sessionId);
    expect(presenceEvent?.sessionId).not.toBe(otherSessionId);
  });

  test("a roving session transition requires a station-bound session before writing", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        rovingTransition: "session_confirm",
        clientOperationId: "unbound-roving-session",
        deviceSequence: 1,
      }),
    ).rejects.toThrow("requires a session-bound station");

    const events = await backend.run((ctx) =>
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_station_time", (index) => index.eq("stationId", fixture.stationId))
        .collect(),
    );
    expect(events).toHaveLength(0);
  });

  test("a bound roving session transition uses the exact configured session", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const configuredSessionId = await openSession(backend, fixture);
    const overlappingSessionId = await insertOpenSession(backend, fixture, {
      stableKey: "other_roving_session",
      bindStation: false,
    });

    const receipt = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "session_confirm",
      clientOperationId: "bound-roving-session",
      deviceSequence: 1,
    });
    expect(receipt).toMatchObject({
      outcome: "accepted",
      transition: "session_confirm",
    });
    const presenceEvent = await backend.run((ctx) =>
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_operator_operation", (index) =>
          index
            .eq("operatorPersonId", fixture.operatorPersonId)
            .eq("clientOperationId", "bound-roving-session"),
        )
        .unique(),
    );
    expect(presenceEvent?.sessionId).toBe(configuredSessionId);
    expect(presenceEvent?.sessionId).not.toBe(overlappingSessionId);
  });

  test("a session scan with no session open in the area is refused", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const sessionId = await openSession(backend, fixture);
    await backend.run((ctx) => ctx.db.patch(sessionId, { status: "scheduled" }));

    const live = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "session_confirm",
      clientOperationId: "scan-no-session",
      deviceSequence: 1,
    });
    expect(live).toMatchObject({ outcome: "rejected", reasonCode: "session_not_open" });

    const replayed = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "session_confirm",
      clientOperationId: "scan-no-session-replay",
      deviceSequence: 2,
      isOfflineReplay: true,
    });
    expect(replayed).toMatchObject({
      outcome: "needs_review",
      reasonCode: "offline_scan_needs_reconciliation",
    });
  });

  test("reusing an operation id for the other direction is refused", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "venue_entry",
      clientOperationId: "scan-same-id",
      deviceSequence: 1,
    });

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        rovingTransition: "venue_exit",
        clientOperationId: "scan-same-id",
        deviceSequence: 1,
      }),
    ).rejects.toThrow("That operation ID was already used for another command.");
  });

  test("an exit scanned in zone B decrements the participant's prior zone A", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const zoneBId = await insertZone(backend, fixture, "zone_b");

    await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "venue_entry",
      clientOperationId: "zone-a-entry",
      deviceSequence: 1,
    });
    await backend.run((ctx) => ctx.db.patch(fixture.stationId, { zoneId: zoneBId }));
    const exit = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      rovingTransition: "venue_exit",
      clientOperationId: "zone-b-exit",
      deviceSequence: 2,
    });
    expect(exit).toMatchObject({ outcome: "accepted", transition: "venue_exit" });

    const counters = await backend.run(async (ctx) => ({
      zoneA: await ctx.db
        .query("attendanceZoneCounterShards")
        .withIndex("by_zone_shard", (index) => index.eq("zoneId", fixture.zoneId))
        .collect(),
      zoneB: await ctx.db
        .query("attendanceZoneCounterShards")
        .withIndex("by_zone_shard", (index) => index.eq("zoneId", zoneBId))
        .collect(),
    }));
    expect(counters.zoneA.reduce((sum, row) => sum + row.inside, 0)).toBe(0);
    expect(counters.zoneB.reduce((sum, row) => sum + row.inside, 0)).toBe(0);
  });

  test("moving an unknown state from zone A to an inside state in zone B updates both owners", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const zoneBId = await insertZone(backend, fixture, "unknown_destination");
    const shard = attendanceCounterShardFor(fixture.membershipId);
    await backend.run(async (ctx) => {
      await ctx.db.insert("attendanceZoneCounterShards", {
        eventId: fixture.eventId,
        zoneId: fixture.zoneId,
        shard,
        inside: 0,
        unknown: 1,
        version: 1,
        updatedAt: fixture.now,
      });
      await moveZoneCounter(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        previousState: "unknown",
        previousZoneId: fixture.zoneId,
        nextState: "inside",
        nextZoneId: zoneBId,
        now: fixture.now,
      });
    });
    const counters = await backend.run(async (ctx) => ({
      zoneA: await ctx.db
        .query("attendanceZoneCounterShards")
        .withIndex("by_zone_shard", (index) =>
          index.eq("zoneId", fixture.zoneId).eq("shard", shard),
        )
        .unique(),
      zoneB: await ctx.db
        .query("attendanceZoneCounterShards")
        .withIndex("by_zone_shard", (index) => index.eq("zoneId", zoneBId).eq("shard", shard))
        .unique(),
    }));
    expect(counters.zoneA).toMatchObject({ inside: 0, unknown: 0 });
    expect(counters.zoneB).toMatchObject({ inside: 1, unknown: 0 });
  });

  test("rejects an external pass until staffed photo-ID verification is complete", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const externalPassLookupHash = await insertExternalPass(backend, fixture);
    await backend.run((ctx) => ctx.db.patch(fixture.stationId, { mode: "venue_entry" }));

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        credentialKind: "external_pass",
        lookupHash: externalPassLookupHash,
        clientOperationId: "unverified-external-pass",
        deviceSequence: 1,
      }),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reasonCode: "external_identity_not_verified",
    });
  });

  test("a verified static external pass supports offline replay and idempotent retries", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const externalPassLookupHash = await insertExternalPass(backend, fixture);
    await insertExternalIdentityBinding(backend, fixture);
    await backend.run((ctx) => ctx.db.patch(fixture.stationId, { mode: "venue_entry" }));
    const onlineArgs = {
      ...scanArguments(fixture),
      credentialKind: "external_pass" as const,
      lookupHash: externalPassLookupHash,
      clientOperationId: "external-pass-online",
      deviceSequence: 1,
    };

    const online = await operator.mutation(internal.attendanceScan.recordScan, onlineArgs);
    const uncertainRetry = await operator.mutation(internal.attendanceScan.recordScan, {
      ...onlineArgs,
      isOfflineReplay: true,
    });
    expect(uncertainRetry).toEqual(online);

    await operator.mutation(internal.attendanceScan.recordScan, {
      ...onlineArgs,
      clientOperationId: "external-pass-offline",
      deviceSequence: 2,
      isOfflineReplay: true,
    });
    const saved = await backend.run((ctx) =>
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_station_time", (index) => index.eq("stationId", fixture.stationId))
        .collect(),
    );
    expect(saved).toHaveLength(2);
  });

  test("keeps scan duty visible while revoked station read hides the phone assignment", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const installationId = `fixture-device-${fixture.now}`;

    await expect(
      operator.query(api.attendanceScanner.current, {
        eventSlug: fixture.eventSlug,
        installationId,
      }),
    ).resolves.toMatchObject({ station: { id: fixture.stationId } });

    await backend.run(async (ctx) => {
      const grant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_event_permission_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("permissionKey", "attendance.station.read")
            .eq("status", "active"),
        )
        .unique();
      if (!grant) throw new Error("The station-read fixture grant is missing.");
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: Date.now(),
        revokedByPersonId: fixture.operatorPersonId,
        revokeReason: "Scanner projection boundary test",
      });
    });

    await expect(
      operator.query(api.access.reviewerCapabilities, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({ attendance: true });
    await expect(
      operator.query(api.attendanceScanner.current, {
        eventSlug: fixture.eventSlug,
        installationId,
      }),
    ).resolves.toBeNull();
    await expect(
      operator.query(api.attendanceScanner.history, {
        eventSlug: fixture.eventSlug,
        installationId,
        paginationOpts: { numItems: 25, cursor: null },
      }),
    ).resolves.toEqual({ page: [], isDone: true, continueCursor: "" });
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "participantServiceQueues");
  return backend;
}

function asOperator(backend: BackendTest, fixture: Fixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

function scanArguments(fixture: Fixture) {
  return {
    eventSlug: fixture.eventSlug,
    stationId: fixture.stationId,
    expectedConfigurationVersion: 1,
    deviceInstallationId: fixture.deviceInstallationId,
    deviceSecretHash: fixture.deviceSecretHash,
    credentialKind: "vit_id_barcode" as const,
    lookupHash: fixture.lookupHash,
    capturedAt: fixture.now,
    isOfflineReplay: false,
  };
}

async function openSession(backend: BackendTest, fixture: Fixture) {
  return insertOpenSession(backend, fixture, {
    stableKey: "fixture_session",
    bindStation: true,
  });
}

async function insertOpenSession(
  backend: BackendTest,
  fixture: Fixture,
  args: { stableKey: string; bindStation: boolean },
) {
  return backend.run(async (ctx) => {
    const sessionId = await ctx.db.insert("attendanceSessions", {
      eventId: fixture.eventId,
      planVersionId: fixture.planVersionId,
      stableKey: args.stableKey,
      name: "Fixture session",
      kind: "hacking",
      requirement: "required",
      expectedCohort: { kind: "all_admitted" },
      zoneId: fixture.zoneId,
      status: "open",
      startsAt: fixture.now - 60_000,
      endsAt: fixture.now + 3_600_000,
      checkInOpensAt: fixture.now - 60_000,
      checkInClosesAt: fixture.now + 3_600_000,
      expectationBuildState: "complete",
      expectationCount: 1,
      version: 1,
      openedAt: fixture.now,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    await ctx.db.insert("attendanceSessionParticipants", {
      eventId: fixture.eventId,
      sessionId,
      membershipId: fixture.membershipId,
      expectation: "required",
      state: "confirmation_due",
      late: false,
      version: 1,
      updatedAt: fixture.now,
    });
    await moveSessionCounter(ctx, {
      eventId: fixture.eventId,
      sessionId,
      membershipId: fixture.membershipId,
      previousState: null,
      nextState: "confirmation_due",
      expectedDelta: 1,
      wasLate: false,
      isLate: false,
      now: fixture.now,
    });
    if (args.bindStation) await ctx.db.patch(fixture.stationId, { sessionId });
    return sessionId;
  });
}

async function insertZone(backend: BackendTest, fixture: Fixture, stableKey: string) {
  return backend.run((ctx) =>
    ctx.db.insert("attendanceZones", {
      eventId: fixture.eventId,
      planVersionId: fixture.planVersionId,
      stableKey,
      name: stableKey,
      createdAt: fixture.now,
    }),
  );
}

async function insertExternalPass(backend: BackendTest, fixture: Fixture) {
  const lookupHash = `external-${crypto.randomUUID()}`;
  await backend.run((ctx) =>
    ctx.db.insert("attendanceExternalPasses", {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      encryptedBearer: "fixture-encrypted-bearer",
      bearerIv: "fixture-bearer-iv",
      bearerAuthTag: "fixture-bearer-auth-tag",
      lookupHash,
      version: 1,
      state: "active",
      issuedAt: fixture.now,
      updatedAt: fixture.now,
    }),
  );
  return lookupHash;
}

async function insertExternalIdentityBinding(backend: BackendTest, fixture: Fixture) {
  await backend.run((ctx) =>
    ctx.db.insert("attendanceExternalIdentityBindings", {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      lookupHash: `external-id-${crypto.randomUUID()}`,
      barcodeSymbology: "code128",
      version: 1,
      state: "active",
      linkedByPersonId: fixture.operatorPersonId,
      linkedAt: fixture.now,
      updatedAt: fixture.now,
    }),
  );
}

async function seedScannerFixture(backend: BackendTest) {
  // recordScan compares capture times with the current clock.
  const now = Date.now();
  const eventSlug = `attendance-scan-${crypto.randomUUID()}`;
  const deviceSecretHash = "fixture-device-secret-hash";
  const lookupHash = "fixture-credential-lookup-hash";
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const seeded = await backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Attendance scan fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operator = await insertAccount(ctx, eventId, "operator", now, authUserId);
    const participant = await insertAccount(ctx, eventId, "participant", now);
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
      createdByPersonId: operator.personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedAttendancePlanVersionId: planVersionId });
    const zoneId = await ctx.db.insert("attendanceZones", {
      eventId,
      planVersionId,
      stableKey: "fixture_zone",
      name: "Fixture zone",
      createdAt: now,
    });
    const deviceInstallationId = await ctx.db.insert("attendanceDeviceInstallations", {
      eventId,
      installationId: `fixture-device-${now}`,
      secretHash: deviceSecretHash,
      name: "Fixture phone",
      platform: "android",
      status: "active",
      registeredByPersonId: operator.personId,
      registeredAt: now,
      lastSeenAt: now,
      pendingReplayCount: 0,
    });
    const stationId = await ctx.db.insert("attendanceStations", {
      eventId,
      planVersionId,
      zoneId,
      deviceInstallationId,
      stableKey: "fixture_station",
      name: "Fixture station",
      mode: "roving",
      allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "external_pass"],
      status: "active",
      configurationVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const sourceId = stationAssignmentSourceId({
      stationId,
      deviceInstallationId,
      operatorPersonId: operator.personId,
    });
    for (const permissionKey of ["attendance.scan.execute", "attendance.station.read"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: operator.personId,
        eventAccessSubjectId: operator.subjectId,
        permissionKey,
        scopeType: "station",
        scopeId: stationId,
        sourceType: "station_assignment",
        sourceId,
        grantedByPersonId: operator.personId,
        reason: "Attendance scan fixture",
      });
    }
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId: participant.personId,
      eventAccessSubjectId: participant.subjectId,
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Fixture team",
      publicCode: `FIXTURE-${crypto.randomUUID()}`,
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 1,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    await initializeAttendanceTeamAvailability(ctx, {
      eventId,
      teamId,
      activeMemberCount: 1,
      now,
    });
    await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId,
      kind: "vit_id_barcode",
      lookupHash,
      barcodeSymbology: "code128",
      normalizationVersion: "trim-v1",
      version: 1,
      state: "active",
      enrolledByPersonId: operator.personId,
      enrolledAt: now,
      verifiedAt: now,
    });
    return {
      eventId,
      planVersionId,
      zoneId,
      stationId,
      deviceInstallationId,
      membershipId,
      operatorPersonId: operator.personId,
    };
  });
  return {
    ...seeded,
    authSessionId,
    authUserId,
    deviceSecretHash,
    eventSlug,
    lookupHash,
    now,
  };
}

async function insertAccount(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  key: string,
  now: number,
  authUserId?: string,
) {
  const email = `${key}-${crypto.randomUUID()}@example.test`;
  const personId = await ctx.db.insert("people", {
    authUserId: authUserId ?? `${key}-${crypto.randomUUID()}`,
    googleSubject: `google-${key}-${crypto.randomUUID()}`,
    verifiedEmail: email,
    displayName: `${key} person`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: email,
    displayName: `${key} person`,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId };
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Station operator",
        email: `station-operator-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}

async function seedCheckIn(backend: BackendTest, fixture: Fixture) {
  await backend.run((ctx) =>
    ctx.db.insert("venueCheckIns", {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      stationId: fixture.stationId,
      zoneId: fixture.zoneId,
      checkedInByPersonId: fixture.operatorPersonId,
      checkedInAt: fixture.now - 60_000,
      identityCheckMethod: "vit_id",
      status: "checked_in",
      version: 1,
    }),
  );
}
