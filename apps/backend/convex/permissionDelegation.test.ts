import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import { requireAccessVersion } from "./lib/accessVersion.ts";
import {
  requireGrantAuthority,
  requireRevokeAuthority,
} from "./lib/permissionDelegation.ts";
import { normalizeBundleEntries } from "./lib/permissionBundleEntries.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("scoped permission administration", () => {
  test("keeps scoped grant authority inside one key, target, resource, and expiry", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAccessFixture(backend);
    const ceiling = Date.now() + 60_000;
    const { grantId: authorityId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.actorPersonId,
        eventAccessSubjectId: fixture.actorSubjectId,
        permissionKey: "access.permissions.grant_scoped",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "fixture-grant-ceiling",
        reason: "Fixture delegation ceiling",
        validUntil: ceiling,
        delegation: {
          permissionKey: "operations.health.read",
          scopeType: "event",
          target: { kind: "exact_person", personId: fixture.targetPersonId },
        },
      }),
    );

    const resolved = await backend.run((ctx) =>
      requireGrantAuthority(ctx, {
        eventId: fixture.eventId,
        eventAccessSubjectId: fixture.actorSubjectId,
        actorPersonId: fixture.actorPersonId,
        action: {
          permissionKey: "operations.health.read",
          scopeType: "event",
          targetPersonId: fixture.targetPersonId,
          validUntil: ceiling - 1,
        },
      }),
    );
    expect(resolved).toEqual({
      permissionKey: "access.permissions.grant_scoped",
      grantIds: [authorityId],
    });

    await expect(
      backend.run((ctx) =>
        requireGrantAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          actorPersonId: fixture.actorPersonId,
          action: {
            permissionKey: "operations.health.read",
            scopeType: "event",
            targetPersonId: fixture.otherPersonId,
            validUntil: ceiling - 1,
          },
        }),
      ),
    ).rejects.toThrow("cannot grant that permission");
    await expect(
      backend.run((ctx) =>
        requireGrantAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          actorPersonId: fixture.actorPersonId,
          action: {
            permissionKey: "operations.health.read",
            scopeType: "event",
            targetPersonId: fixture.targetPersonId,
            validUntil: ceiling + 1,
          },
        }),
      ),
    ).rejects.toThrow("cannot grant that permission");

    await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.actorPersonId,
        eventAccessSubjectId: fixture.actorSubjectId,
        permissionKey: "access.permissions.grant_scoped",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "fixture-resource-ceiling",
        reason: "Fixture exact resource ceiling",
        validUntil: ceiling,
        delegation: {
          permissionKey: "round.read",
          scopeType: "round",
          scopeId: "round-one",
          target: { kind: "exact_person", personId: fixture.targetPersonId },
        },
      }),
    );
    await expect(
      backend.run((ctx) =>
        requireGrantAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          actorPersonId: fixture.actorPersonId,
          action: {
            permissionKey: "round.read",
            scopeType: "round",
            scopeId: "round-two",
            targetPersonId: fixture.targetPersonId,
            validUntil: ceiling - 1,
          },
        }),
      ),
    ).rejects.toThrow("cannot grant that permission");
  });

  test("keeps grant, revoke, and administration authority independent", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAccessFixture(backend);
    const ceiling = Date.now() + 60_000;
    const { grantId: revokeAuthorityId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.actorPersonId,
        eventAccessSubjectId: fixture.actorSubjectId,
        permissionKey: "access.permissions.revoke_scoped",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "fixture-revoke-ceiling",
        reason: "Fixture revoke ceiling",
        validUntil: ceiling,
        delegation: {
          permissionKey: "operations.health.read",
          scopeType: "event",
          target: { kind: "any_event_person" },
        },
      }),
    );

    const revokeAuthority = await backend.run((ctx) =>
      requireRevokeAuthority(ctx, {
        eventId: fixture.eventId,
        eventAccessSubjectId: fixture.actorSubjectId,
        action: {
          permissionKey: "operations.health.read",
          scopeType: "event",
          targetPersonId: fixture.targetPersonId,
        },
      }),
    );
    expect(revokeAuthority).toEqual({
      permissionKey: "access.permissions.revoke_scoped",
      grantIds: [revokeAuthorityId],
    });

    await expect(
      backend.run((ctx) =>
        requireGrantAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          actorPersonId: fixture.actorPersonId,
          action: {
            permissionKey: "operations.health.read",
            scopeType: "event",
            targetPersonId: fixture.targetPersonId,
            validUntil: ceiling - 1,
          },
        }),
      ),
    ).rejects.toThrow("cannot grant that permission");
    await expect(
      backend.run((ctx) =>
        requireRevokeAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          action: {
            permissionKey: "access.permissions.grant_any",
            scopeType: "event",
            targetPersonId: fixture.targetPersonId,
          },
        }),
      ),
    ).rejects.toThrow("cannot revoke permission-administration authority");
  });

  test("reserves administration keys and self-grants for unrestricted grant authority", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAccessFixture(backend);
    const action = {
      permissionKey: "access.permissions.grant_scoped" as const,
      scopeType: "event" as const,
      targetPersonId: fixture.actorPersonId,
      validUntil: Date.now() + 60_000,
    };

    await expect(
      backend.run((ctx) =>
        requireGrantAuthority(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.actorSubjectId,
          actorPersonId: fixture.actorPersonId,
          action,
        }),
      ),
    ).rejects.toThrow("cannot create permission-administration authority");

    const { grantId: rootGrantId } = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.actorPersonId,
        eventAccessSubjectId: fixture.actorSubjectId,
        permissionKey: "access.permissions.grant_any",
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: "fixture-root",
        reason: "Fixture root authority",
      }),
    );
    const resolved = await backend.run((ctx) =>
      requireGrantAuthority(ctx, {
        eventId: fixture.eventId,
        eventAccessSubjectId: fixture.actorSubjectId,
        actorPersonId: fixture.actorPersonId,
        action,
      }),
    );
    expect(resolved).toEqual({
      permissionKey: "access.permissions.grant_any",
      grantIds: [rootGrantId],
    });
  });

  test("rejects unbounded, target-owned, and bundle-authored delegations", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAccessFixture(backend);

    await expect(
      backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.actorPersonId,
          eventAccessSubjectId: fixture.actorSubjectId,
          permissionKey: "access.permissions.grant_scoped",
          scopeType: "event",
          sourceType: "manual",
          sourceId: "unbounded",
          reason: "Missing expiry ceiling",
          delegation: {
            permissionKey: "operations.health.read",
            scopeType: "event",
            target: { kind: "any_event_person" },
          },
        }),
      ),
    ).rejects.toThrow("time-bounded");

    await expect(
      backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.actorPersonId,
          eventAccessSubjectId: fixture.actorSubjectId,
          permissionKey: "access.permissions.grant_scoped",
          scopeType: "event",
          sourceType: "manual",
          sourceId: "target-owned",
          reason: "Invalid broad self delegation",
          validUntil: Date.now() + 60_000,
          delegation: {
            permissionKey: "participant.profile.read",
            scopeType: "self",
            scopeId: fixture.targetSubjectId,
            target: { kind: "any_event_person" },
          },
        }),
      ),
    ).rejects.toThrow("requires one exact target person");

    expect(() =>
      normalizeBundleEntries([
        {
          permissionKey: "access.permissions.grant_scoped",
          scopeType: "event",
          scopeSource: "event",
          validityRule: "bundle",
        },
      ]),
    ).toThrow("one explicit person-specific delegation");
  });

  test("allows one access-version winner and rejects the stale concurrent writer", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAccessFixture(backend);
    const advance = () =>
      backend.run(async (ctx) => {
        const subject = await ctx.db.get(fixture.targetSubjectId);
        if (!subject) throw new Error("Target subject is missing.");
        requireAccessVersion(subject, 1);
        await ctx.db.patch(subject._id, {
          accessVersion: 2,
          updatedAt: Date.now(),
        });
      });

    const results = await Promise.allSettled([advance(), advance()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const subject = await backend.run((ctx) => ctx.db.get(fixture.targetSubjectId));
    expect(subject?.accessVersion).toBe(2);
  });

  test("publishes both scoped authority keys in the exact catalog", () => {
    expect(permissionCatalog["access.permissions.grant_scoped"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["access.permissions.revoke_scoped"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });
});

async function seedAccessFixture(backend: BackendTest) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `delegation-${now}`,
      name: "Delegation fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const actor = await insertEventPerson(ctx, eventId, "actor", now);
    const target = await insertEventPerson(ctx, eventId, "target", now);
    const other = await insertEventPerson(ctx, eventId, "other", now);
    return {
      eventId,
      actorPersonId: actor.personId,
      actorSubjectId: actor.subjectId,
      targetPersonId: target.personId,
      targetSubjectId: target.subjectId,
      otherPersonId: other.personId,
    };
  });
}

async function insertEventPerson(
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
