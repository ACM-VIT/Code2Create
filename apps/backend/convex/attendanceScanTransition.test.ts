import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { moveSessionCounter } from "./lib/attendanceCounters.ts";
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

/**
 * A station is a phone at a place. Which way a person is walking is something
 * the operator marks on the scan, so every one of these runs through the same
 * station row without touching its configuration.
 */
describe("attendance scan direction", () => {
  test("one station records a participant arriving and then leaving", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);

    const entry = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      transition: "venue_entry",
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
      transition: "venue_exit",
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

  test("a session scan resolves whichever session is open in the station's area", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);
    const sessionId = await openSession(backend, fixture);

    const receipt = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      transition: "session_confirm",
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
    const presenceEvent = await backend.run((ctx) => ctx.db.get(receipt.presenceEventId));
    expect(presenceEvent?.sessionId).toBe(sessionId);
  });

  test("a session scan with no session open in the area is refused", async () => {
    const backend = seededBackend();
    const fixture = await seedScannerFixture(backend);
    const operator = asOperator(backend, fixture);

    const live = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      transition: "session_confirm",
      clientOperationId: "scan-no-session",
      deviceSequence: 1,
    });
    expect(live).toMatchObject({ outcome: "rejected", reasonCode: "session_not_open" });

    // A scan taken offline cannot be told the session was missing, so it comes
    // back for staff rather than being thrown away.
    const replayed = await operator.mutation(internal.attendanceScan.recordScan, {
      ...scanArguments(fixture),
      transition: "session_confirm",
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
      transition: "venue_entry",
      clientOperationId: "scan-same-id",
      deviceSequence: 1,
    });

    await expect(
      operator.mutation(internal.attendanceScan.recordScan, {
        ...scanArguments(fixture),
        transition: "venue_exit",
        clientOperationId: "scan-same-id",
        deviceSequence: 1,
      }),
    ).rejects.toThrow("Operation ID was reused.");
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
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
  return backend.run(async (ctx) => {
    const sessionId = await ctx.db.insert("attendanceSessions", {
      eventId: fixture.eventId,
      planVersionId: fixture.planVersionId,
      stableKey: "fixture_session",
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
    // Expectation building is what normally puts a person on the counter, and
    // the projection refuses to move a counter it was never added to.
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
    return sessionId;
  });
}

async function seedScannerFixture(backend: BackendTest) {
  // recordScan judges capture times against the real clock, so the fixture has
  // to sit on it rather than on a fixed date.
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
    for (const permissionKey of [
      "attendance.scan.execute",
      "attendance.station.read",
    ] as const) {
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
    // Venue projection moves the participant's team availability, which only
    // exists once they are on a confirmed team.
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Fixture team",
      publicCode: `FIXTURE-${crypto.randomUUID()}`,
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
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
    return { eventId, planVersionId, zoneId, stationId, deviceInstallationId, membershipId };
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
