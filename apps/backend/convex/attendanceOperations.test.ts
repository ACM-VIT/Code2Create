import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api.js";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const actionPermissions = [
  { key: "attendance.remedy.open", capability: "canOpenRemedy" },
  { key: "attendance.remedy.decide", capability: "canDecideRemedy" },
  { key: "attendance.roll_call.start", capability: "canStartRollCall" },
  { key: "attendance.roll_call.close", capability: "canCloseRollCall" },
  { key: "attendance.manual_sheet.enter", capability: "canEnterManualSheets" },
  { key: "attendance.manual_sheet.verify", capability: "canVerifyManualSheets" },
  { key: "attendance.manual_sheet.source.read", capability: "canReadManualSources" },
] as const;

describe("attendance operations visibility", () => {
  test("an exact-session action grant exposes its session and capability", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.UTC(2027, 8, 10, 8);
    const identities: Array<{ authUserId: string; authSessionId: string }> = [];
    for (const index of actionPermissions.keys()) {
      const authUserId = await createAuthUser(backend, now, index);
      identities.push({
        authUserId,
        authSessionId: await createAuthSession(backend, authUserId, now, index),
      });
    }
    const fixture = await backend.run(async (ctx) => {
      const ownerId = await ctx.db.insert("people", {
        authUserId: `attendance-owner-${now}`,
        googleSubject: `attendance-owner-subject-${now}`,
        verifiedEmail: `attendance-owner-${now}@example.test`,
        displayName: "Attendance owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        slug: `attendance-operations-${now}`,
        name: "Attendance operations fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        startsAt: now - 60_000,
        endsAt: now + 3_600_000,
        createdByPersonId: ownerId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const planVersionId = await ctx.db.insert("attendancePlanVersions", {
        eventId,
        version: 1,
        name: "Operations plan",
        vitBarcodeSymbologies: ["code128"],
        vitBarcodeNormalizationVersion: "trim-v1",
        offlineQueueMaxScans: 8,
        offlineQueueMaxAgeSeconds: 180,
        status: "published",
        checksum: "operations-plan",
        createdByPersonId: ownerId,
        createdAt: now,
        publishedAt: now,
      });
      await ctx.db.patch(eventId, { publishedAttendancePlanVersionId: planVersionId });
      const zoneId = await ctx.db.insert("attendanceZones", {
        eventId,
        planVersionId,
        stableKey: "operations_zone",
        name: "Operations zone",
        createdAt: now,
      });
      const sessionId = await ctx.db.insert("attendanceSessions", {
        eventId,
        planVersionId,
        stableKey: "operations_session",
        name: "Operations session",
        kind: "hacking",
        requirement: "required",
        expectedCohort: { kind: "all_admitted" },
        zoneId,
        status: "ready",
        startsAt: now,
        endsAt: now + 3_600_000,
        checkInOpensAt: now - 60_000,
        checkInClosesAt: now + 3_600_000,
        expectationBuildState: "complete",
        expectationCount: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const readers = [];
      for (const [index, permission] of actionPermissions.entries()) {
        const identity = identities[index];
        if (!identity) throw new Error("Attendance action identity is missing.");
        const { authUserId } = identity;
        const personId = await ctx.db.insert("people", {
          authUserId,
          googleSubject: `attendance-action-subject-${index}-${now}`,
          verifiedEmail: `attendance-action-${index}-${now}@example.test`,
          displayName: `Attendance action ${index}`,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        const subjectId = await ctx.db.insert("eventAccessSubjects", {
          eventId,
          personId,
          emailNormalized: `attendance-action-${index}-${now}@example.test`,
          displayName: `Attendance action ${index}`,
          status: "active",
          linkedBy: "access_invitation",
          accessVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
        await insertPermissionGrant(ctx, {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey: permission.key,
          scopeType: "attendance_session",
          scopeId: sessionId,
          sourceType: "manual",
          sourceId: `attendance-action-${index}`,
          grantedByPersonId: ownerId,
          reason: "Attendance action visibility test",
        });
        readers.push({ ...identity, permission });
      }
      return { eventSlug: `attendance-operations-${now}`, sessionId, readers };
    });

    for (const reader of fixture.readers) {
      const result = await backend
        .withIdentity({ subject: reader.authUserId, sessionId: reader.authSessionId })
        .query(api.attendanceOperations.overview, { eventSlug: fixture.eventSlug });
      expect(result.sessions).toHaveLength(1);
      const session = result.sessions[0];
      if (!session) throw new Error("The granted attendance session is missing.");
      expect(session.id).toBe(fixture.sessionId);
      expect(session[reader.permission.capability]).toBe(true);
    }
  });
});

async function createAuthUser(backend: BackendTest, now: number, index: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `Attendance action ${index}`,
        email: `attendance-action-${index}-${now}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
  index: number,
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: `attendance-action-session-${index}-${now}`,
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
