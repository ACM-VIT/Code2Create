import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  sweepPermissionGrantLifecycle,
  transitionPermissionGrant,
} from "./lib/permissionGrantLifecycle.ts";
import {
  insertPermissionGrant,
  matchingPermissionGrantIds,
  revokeSourceGrants,
} from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

afterEach(() => {
  vi.useRealTimers();
});

describe("permission grant lifecycle", () => {
  test("makes future grants scheduled, effective at activation, and ineffective at expiry", async () => {
    const now = Date.UTC(2027, 0, 2, 3, 4, 5);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const validFrom = now + 10_000;
    const validUntil = now + 20_000;
    const { grantId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "scheduled-health",
        reason: "Scheduled operations duty",
        validFrom,
        validUntil,
      }),
    );

    const scheduled = await backend.run((ctx) => ctx.db.get(grantId));
    expect(scheduled?.status).toBe("scheduled");
    expect(scheduled?.activatedAt).toBeUndefined();
    expect(
      await matchingIds(backend, fixture, "operations.health.read"),
    ).toEqual([]);

    vi.setSystemTime(validFrom);
    expect(
      await backend.run((ctx) =>
        transitionPermissionGrant(ctx, { grantId, now: validFrom }),
      ),
    ).toBe("activated");
    const active = await backend.run((ctx) => ctx.db.get(grantId));
    expect(active?.status).toBe("active");
    expect(active?.activatedAt).toBe(validFrom);
    expect(
      await matchingIds(backend, fixture, "operations.health.read"),
    ).toEqual([grantId]);
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);

    expect(
      await backend.run((ctx) =>
        transitionPermissionGrant(ctx, { grantId, now: validFrom }),
      ),
    ).toBe("unchanged");
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);

    vi.setSystemTime(validUntil);
    expect(
      await backend.run((ctx) =>
        transitionPermissionGrant(ctx, { grantId, now: validUntil }),
      ),
    ).toBe("expired");
    const expired = await backend.run((ctx) => ctx.db.get(grantId));
    expect(expired?.status).toBe("expired");
    expect(expired?.expiredAt).toBe(validUntil);
    expect(
      await matchingIds(backend, fixture, "operations.health.read"),
    ).toEqual([]);
    expect(await accessVersion(backend, fixture.subjectId)).toBe(3);
  });

  test("never resurrects a grant when revocation races its activation job", async () => {
    const now = Date.UTC(2027, 1, 3, 4, 5, 6);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const validFrom = now + 10_000;
    const { grantId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "racing-health",
        reason: "Temporary operations duty",
        validFrom,
      }),
    );

    vi.setSystemTime(validFrom);
    await Promise.all([
      backend.run((ctx) =>
        transitionPermissionGrant(ctx, { grantId, now: validFrom }),
      ),
      backend.run((ctx) =>
        revokeSourceGrants(ctx, {
          eventId: fixture.eventId,
          sourceType: "manual",
          sourceId: "racing-health",
          reason: "Duty cancelled",
        }),
      ),
    ]);

    const grant = await backend.run((ctx) => ctx.db.get(grantId));
    expect(grant?.status).toBe("revoked");
    expect(
      await matchingIds(backend, fixture, "operations.health.read"),
    ).toEqual([]);
    expect(await accessVersion(backend, fixture.subjectId)).toBeGreaterThan(1);
  });

  test("revokes every current grant from one source and advances its subject once", async () => {
    const now = Date.UTC(2027, 2, 1, 2, 3, 4);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const validFrom = now + 10_000;
    const { grantId: firstGrantId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "cancelled-duty",
        reason: "Scheduled operations duty",
        validFrom,
      }),
    );
    const { grantId: secondGrantId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "operations.intelligence.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "cancelled-duty",
        reason: "Scheduled operations duty",
        validFrom,
      }),
    );

    await backend.run((ctx) =>
      revokeSourceGrants(ctx, {
        eventId: fixture.eventId,
        sourceType: "manual",
        sourceId: "cancelled-duty",
        reason: "Duty cancelled",
      }),
    );
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);
    expect(
      await Promise.all(
        [firstGrantId, secondGrantId].map((grantId) =>
          backend.run((ctx) => ctx.db.get(grantId)),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ status: "revoked" }),
      expect.objectContaining({ status: "revoked" }),
    ]);

    await backend.run((ctx) =>
      revokeSourceGrants(ctx, {
        eventId: fixture.eventId,
        sourceType: "manual",
        sourceId: "cancelled-duty",
        reason: "Idempotent retry",
      }),
    );
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);
    expect(
      await backend.run((ctx) =>
        transitionPermissionGrant(ctx, { grantId: firstGrantId, now: validFrom }),
      ),
    ).toBe("unchanged");
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);
  });

  test("repairs due grants in bounded batches and advances each subject once per sweep", async () => {
    const now = Date.UTC(2027, 2, 4, 5, 6, 7);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const dueAt = now + 10_000;
    const firstGrantId = await scheduledGrant(
      backend,
      fixture,
      "first-source",
      dueAt,
      now + 30_000,
    );
    const secondGrantId = await scheduledGrant(
      backend,
      fixture,
      "second-source",
      dueAt,
      now + 30_000,
    );
    const elapsedGrantId = await scheduledGrant(
      backend,
      fixture,
      "elapsed-source",
      now + 2_000,
      now + 4_000,
    );

    const firstSweep = await backend.run((ctx) =>
      sweepPermissionGrantLifecycle(ctx, { now: dueAt, limit: 1 }),
    );
    expect(firstSweep).toEqual({
      activated: 0,
      expired: 1,
      affectedSubjects: 1,
      hasMore: true,
    });
    expect(await accessVersion(backend, fixture.subjectId)).toBe(2);

    const secondSweep = await backend.run((ctx) =>
      sweepPermissionGrantLifecycle(ctx, { now: dueAt, limit: 10 }),
    );
    expect(secondSweep).toEqual({
      activated: 2,
      expired: 0,
      affectedSubjects: 1,
      hasMore: false,
    });
    expect(await accessVersion(backend, fixture.subjectId)).toBe(3);
    const grants = await Promise.all(
      [firstGrantId, secondGrantId, elapsedGrantId].map((grantId) =>
        backend.run((ctx) => ctx.db.get(grantId)),
      ),
    );
    expect(grants.filter((grant) => grant?.status === "active")).toHaveLength(2);
    expect(grants.filter((grant) => grant?.status === "expired")).toHaveLength(1);
  });

  test("rejects grant windows that have already ended", async () => {
    const now = Date.UTC(2027, 3, 5, 6, 7, 8);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);

    await expect(
      backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.personId,
          eventAccessSubjectId: fixture.subjectId,
          permissionKey: "operations.health.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: "already-ended",
          reason: "Invalid elapsed window",
          validFrom: now - 20_000,
          validUntil: now - 10_000,
        }),
      ),
    ).rejects.toThrow("Permission grant validity is invalid");
  });
});

async function matchingIds(
  backend: BackendTest,
  fixture: Fixture,
  permissionKey: "operations.health.read",
) {
  return backend.run((ctx) =>
    matchingPermissionGrantIds(ctx, {
      eventId: fixture.eventId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey,
      scopeType: "event",
    }),
  );
}

async function scheduledGrant(
  backend: BackendTest,
  fixture: Fixture,
  sourceId: string,
  validFrom: number,
  validUntil: number,
) {
  const result = await backend.run((ctx) =>
    insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey: "operations.health.read",
      scopeType: "event",
      sourceType: "manual",
      sourceId,
      reason: "Lifecycle sweep fixture",
      validFrom,
      validUntil,
    }),
  );
  return result.grantId;
}

async function accessVersion(
  backend: BackendTest,
  subjectId: Id<"eventAccessSubjects">,
) {
  const subject = await backend.run((ctx) => ctx.db.get(subjectId));
  if (!subject) throw new Error("Fixture event access subject is missing.");
  return subject.accessVersion;
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `permission-lifecycle-${now}`,
      name: "Permission lifecycle fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `lifecycle-user-${now}`,
      googleSubject: `lifecycle-subject-${now}`,
      verifiedEmail: `lifecycle-${now}@example.test`,
      displayName: "Lifecycle person",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `lifecycle-${now}@example.test`,
      displayName: "Lifecycle person",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { eventId, personId, subjectId };
  });
}
