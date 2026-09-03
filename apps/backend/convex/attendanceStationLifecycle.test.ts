import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  disableAssignedAttendanceStation,
  enableDisabledAttendanceStation,
  requireReplaceableAttendancePlan,
  retireAttendancePlanStations,
  stationAssignmentSourceId,
} from "./lib/attendanceStations.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("attendance station lifecycle", () => {
  test("disabling a station revokes its phone and assignment grants in one transition", async () => {
    const now = Date.UTC(2027, 7, 8, 9, 10, 11);
    const backend = convexTest(schema, modules);
    const fixture = await seedStationFixture(backend, now);

    const result = await backend.run(async (ctx) => {
      const station = await ctx.db.get(fixture.stationId);
      if (!station) throw new Error("Fixture station is missing.");
      return disableAssignedAttendanceStation(ctx, {
        eventId: fixture.eventId,
        station,
        disabledByPersonId: fixture.managerPersonId,
        reason: "Phone removed from scanner service",
        now,
      });
    });

    expect(result).toEqual({
      configurationVersion: 5,
      deviceInstallationId: fixture.deviceInstallationId,
    });
    const state = await stationState(backend, fixture);
    expect(state.station).toMatchObject({
      status: "disabled",
      configurationVersion: 5,
      updatedAt: now,
    });
    expect(state.station.deviceInstallationId).toBeUndefined();
    expect(state.device).toMatchObject({ status: "revoked", revokedAt: now });
    expect(state.grants).toHaveLength(2);
    expect(state.grants.every((grant) => grant.status === "revoked")).toBe(true);
    expect(state.operatorAccessVersion).toBe(2);
  });

  test("making a disabled station available does not revive its old phone or grants", async () => {
    const now = Date.UTC(2027, 8, 9, 10, 11, 12);
    const backend = convexTest(schema, modules);
    const fixture = await seedStationFixture(backend, now);
    await backend.run(async (ctx) => {
      const station = await ctx.db.get(fixture.stationId);
      if (!station) throw new Error("Fixture station is missing.");
      await disableAssignedAttendanceStation(ctx, {
        eventId: fixture.eventId,
        station,
        disabledByPersonId: fixture.managerPersonId,
        reason: "Phone removed from scanner service",
        now,
      });
    });
    const enabled = await backend.run(async (ctx) => {
      const station = await ctx.db.get(fixture.stationId);
      if (!station) throw new Error("Fixture station is missing.");
      return enableDisabledAttendanceStation(ctx, { station, now: now + 1 });
    });

    expect(enabled).toEqual({ configurationVersion: 6 });
    const state = await stationState(backend, fixture);
    expect(state.station).toMatchObject({
      status: "inactive",
      configurationVersion: 6,
      updatedAt: now + 1,
    });
    expect(state.station.deviceInstallationId).toBeUndefined();
    expect(state.device.status).toBe("revoked");
    expect(state.grants.every((grant) => grant.status === "revoked")).toBe(true);
    expect(state.operatorAccessVersion).toBe(2);
  });

  test("retiring a plan disables every old station and counts only real device teardowns", async () => {
    const now = Date.UTC(2027, 9, 10, 11, 12, 13);
    const backend = convexTest(schema, modules);
    const fixture = await seedStationFixture(backend, now);
    const extra = await backend.run(async (ctx) => {
      const secondDeviceInstallationId = await ctx.db.insert("attendanceDeviceInstallations", {
        eventId: fixture.eventId,
        installationId: `fixture-device-second-${now}`,
        secretHash: "fixture-secret-hash-second",
        name: "Fixture phone second",
        platform: "ios",
        status: "active",
        registeredByPersonId: fixture.operatorPersonId,
        registeredAt: now,
        lastSeenAt: now,
        pendingReplayCount: 0,
      });
      const secondActiveStationId = await ctx.db.insert("attendanceStations", {
        eventId: fixture.eventId,
        planVersionId: fixture.planVersionId,
        zoneId: fixture.zoneId,
        deviceInstallationId: secondDeviceInstallationId,
        stableKey: "fixture_station_second",
        name: "Fixture station second",
        mode: "venue_entry",
        allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"],
        status: "active",
        configurationVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
      const secondSourceId = stationAssignmentSourceId({
        stationId: secondActiveStationId,
        deviceInstallationId: secondDeviceInstallationId,
        operatorPersonId: fixture.operatorPersonId,
      });
      for (const permissionKey of ["attendance.scan.execute", "attendance.station.read"] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.operatorPersonId,
          eventAccessSubjectId: fixture.operatorSubjectId,
          permissionKey,
          scopeType: "station",
          scopeId: secondActiveStationId,
          sourceType: "station_assignment",
          sourceId: secondSourceId,
          grantedByPersonId: fixture.managerPersonId,
          reason: "Attendance station fixture",
        });
      }
      const inactiveStationId = await ctx.db.insert("attendanceStations", {
        eventId: fixture.eventId,
        planVersionId: fixture.planVersionId,
        zoneId: fixture.zoneId,
        stableKey: "fixture_spare",
        name: "Fixture spare",
        mode: "venue_entry",
        allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"],
        status: "inactive",
        configurationVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { inactiveStationId, secondActiveStationId };
    });

    const result = await backend.run(async (ctx) => {
      const [activeStation, inactiveStation] = await Promise.all([
        ctx.db.get(fixture.stationId),
        ctx.db.get(extra.inactiveStationId),
      ]);
      const secondActiveStation = await ctx.db.get(extra.secondActiveStationId);
      if (!activeStation || !secondActiveStation || !inactiveStation) {
        throw new Error("Fixture stations are missing.");
      }
      return retireAttendancePlanStations(ctx, {
        eventId: fixture.eventId,
        stations: [activeStation, secondActiveStation, inactiveStation],
        retiredByPersonId: fixture.managerPersonId,
        reason: "Attendance plan replaced",
        now: now + 1,
      });
    });

    expect(result).toEqual({ retiredStationCount: 3, revokedDeviceCount: 2 });
    expect(await backend.run((ctx) => ctx.db.get(fixture.stationId))).toMatchObject({
      status: "disabled",
      configurationVersion: 5,
      updatedAt: now + 1,
    });
    expect(await backend.run((ctx) => ctx.db.get(extra.secondActiveStationId))).toMatchObject({
      status: "disabled",
      configurationVersion: 3,
      updatedAt: now + 1,
    });
    expect(await backend.run((ctx) => ctx.db.get(extra.inactiveStationId))).toMatchObject({
      status: "disabled",
      configurationVersion: 2,
      updatedAt: now + 1,
    });
    const operatorSubject = await backend.run((ctx) => ctx.db.get(fixture.operatorSubjectId));
    expect(operatorSubject?.accessVersion).toBe(2);
  });

  test("a prepared or live session blocks attendance plan replacement", () => {
    for (const status of ["preparing", "ready", "open", "closing"] as const) {
      expect(() => requireReplaceableAttendancePlan([{ status }])).toThrow(
        "Cancel or finish every prepared or live attendance session",
      );
    }
  });
});

type StationFixture = Awaited<ReturnType<typeof seedStationFixture>>;

async function stationState(backend: BackendTest, fixture: StationFixture) {
  return backend.run(async (ctx) => {
    const [station, device, operatorSubject, grants] = await Promise.all([
      ctx.db.get(fixture.stationId),
      ctx.db.get(fixture.deviceInstallationId),
      ctx.db.get(fixture.operatorSubjectId),
      ctx.db
        .query("permissionGrants")
        .withIndex("by_source", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("sourceType", "station_assignment")
            .eq("sourceId", fixture.sourceId),
        )
        .collect(),
    ]);
    if (!station || !device || !operatorSubject) {
      throw new Error("Attendance station fixture no longer resolves.");
    }
    return {
      station,
      device,
      grants,
      operatorAccessVersion: operatorSubject.accessVersion,
    };
  });
}

async function seedStationFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `attendance-station-${now}`,
      name: "Attendance station fixture",
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
    const manager = await insertPerson(ctx, eventId, "manager", now);
    const operator = await insertPerson(ctx, eventId, "operator", now);
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
      createdByPersonId: manager.personId,
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
      secretHash: "fixture-secret-hash",
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
      mode: "venue_entry",
      allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"],
      status: "active",
      configurationVersion: 4,
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
        grantedByPersonId: manager.personId,
        reason: "Attendance station fixture",
      });
    }
    return {
      eventId,
      planVersionId,
      zoneId,
      stationId,
      deviceInstallationId,
      managerPersonId: manager.personId,
      operatorPersonId: operator.personId,
      operatorSubjectId: operator.subjectId,
      sourceId,
    };
  });
}

async function insertPerson(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  key: string,
  now: number,
) {
  const personId = await ctx.db.insert("people", {
    authUserId: `${key}-user-${now}`,
    googleSubject: `${key}-subject-${now}`,
    verifiedEmail: `${key}-${now}@example.test`,
    displayName: `${key} person`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `${key}-${now}@example.test`,
    displayName: `${key} person`,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId };
}
