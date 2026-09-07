import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import { grantPanelMemberAccess } from "./lib/reviewAccess.ts";
import {
  boundedActivePermissionScopeIds,
  insertPermissionGrant,
  insertPermissionGrantGroup,
  maximumCurrentGrantsPerPermissionScope,
  maximumCurrentGrantsPerSource,
  type PermissionGrantPlan,
} from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("permission grant writes", () => {
  test("reports idempotent row creation and rejects a mismatched target account", async () => {
    const now = Date.UTC(2027, 4, 6, 7, 8, 9);
    const backend = convexTest(schema, modules);
    const fixture = await seedWriteFixture(backend, now);
    const first = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.reviewerPersonId,
        eventAccessSubjectId: fixture.reviewerSubjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "idempotent-write",
        reason: "Permission write fixture",
      }),
    );
    const retry = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.reviewerPersonId,
        eventAccessSubjectId: fixture.reviewerSubjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "idempotent-write",
        reason: "Permission write fixture",
      }),
    );
    expect(first.created).toBe(true);
    expect(retry).toEqual({ grantId: first.grantId, created: false });

    await expect(
      backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.grantorPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "operations.health.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: "mismatched-target",
          reason: "Invalid target fixture",
        }),
      ),
    ).rejects.toThrow("one active event account");
  });

  test("writes a bounded source group once and makes the full retry idempotent", async () => {
    const now = Date.UTC(2027, 4, 7, 7, 8, 9);
    const backend = convexTest(schema, modules);
    const fixture = await seedWriteFixture(backend, now);
    const grants: PermissionGrantPlan[] = [
      { permissionKey: "operations.health.read", scopeType: "event" },
      { permissionKey: "event.lifecycle.read", scopeType: "event" },
      { permissionKey: "operations.health.read", scopeType: "event" },
    ];
    const args = {
      eventId: fixture.eventId,
      personId: fixture.reviewerPersonId,
      eventAccessSubjectId: fixture.reviewerSubjectId,
      sourceType: "production_seed" as const,
      sourceId: "grouped-local-bootstrap",
      grantedByPersonId: fixture.grantorPersonId,
      reason: "Grouped permission fixture",
      grants,
    };

    const first = await backend.run((ctx) => insertPermissionGrantGroup(ctx, args),
    );
    expect(first.createdCount).toBe(2);
    expect(first.results.map((result) => result.created)).toEqual([true, true, false,
    ]);
    expect(first.results[2]?.grantId).toBe(first.results[0]?.grantId);

    const retry = await backend.run((ctx) => insertPermissionGrantGroup(ctx, args),
    );
    expect(retry.createdCount).toBe(0);
    expect(retry.results.map((result) => result.created)).toEqual([false, false, false,
    ]);
    expect(retry.results.map((result) => result.grantId)).toEqual(
      first.results.map((result) => result.grantId),
    );
    expect(
      await activeSourceGrantCount(backend, fixture.eventId, "production_seed", args.sourceId,
      ),
    ).toBe(2);
    await expect(
      backend.run((ctx) =>
        insertPermissionGrantGroup(ctx, {
          ...args,
          reason: "Changed grouped permission fixture",
        }),
      ),
    ).rejects.toThrow("different grant semantics");

    const conflictingDelegations: PermissionGrantPlan[] = [
      {
        permissionKey: "access.permissions.grant_scoped",
        scopeType: "event",
        delegation: {
          permissionKey: "operations.health.read",
          scopeType: "event",
          target: { kind: "any_event_person" },
        },
      },
      {
        permissionKey: "access.permissions.grant_scoped",
        scopeType: "event",
        delegation: {
          permissionKey: "event.lifecycle.read",
          scopeType: "event",
          target: { kind: "any_event_person" },
        },
      },
    ];
    await expect(
      backend.run((ctx) =>
        insertPermissionGrantGroup(ctx, {
          ...args,
          sourceId: "conflicting-delegation-group",
          validUntil: Date.now() + 60_000,
          grants: conflictingDelegations,
        }),
      ),
    ).rejects.toThrow("different delegation");
    expect(
      await activeSourceGrantCount(
        backend,
        fixture.eventId,
        "production_seed",
        "conflicting-delegation-group",
      ),
    ).toBe(0);

    const oversizedGrants: PermissionGrantPlan[] = Array.from(
      { length: maximumCurrentGrantsPerSource + 1 },
      () => ({ permissionKey: "event.lifecycle.read", scopeType: "event" }),
    );
    await expect(
      backend.run((ctx) =>
        insertPermissionGrantGroup(ctx, {
          ...args,
          sourceId: "oversized-group",
          grants: oversizedGrants,
        }),
      ),
    ).rejects.toThrow("exceeds the current-grant source limit");
    expect(
      await activeSourceGrantCount(backend, fixture.eventId, "production_seed", "oversized-group",
      ),
    ).toBe(0);
  });

  test("advances one access version for a panel grant group and none for its retry", async () => {
    const now = Date.UTC(2027, 5, 7, 8, 9, 10);
    const backend = convexTest(schema, modules);
    const fixture = await seedWriteFixture(backend, now);
    const review = await seedReviewAssignment(backend, fixture, now);
    const args = {
      eventId: fixture.eventId,
      roundId: review.roundId,
      panelId: review.panelId,
      panelMemberId: review.panelMemberId,
      reviewerPersonId: fixture.reviewerPersonId,
      eventAccessSubjectId: fixture.reviewerSubjectId,
      grantedByPersonId: fixture.grantorPersonId,
      isCoordinator: false,
      reason: "Panel assignment fixture",
    };

    await backend.run((ctx) => grantPanelMemberAccess(ctx, args));
    expect(await subjectAccessVersion(backend, fixture.reviewerSubjectId)).toBe(2,
    );
    expect(await sourceGrantCount(backend, fixture.eventId, review.panelMemberId),
    ).toBe(5);

    await backend.run((ctx) => grantPanelMemberAccess(ctx, args));
    expect(await subjectAccessVersion(backend, fixture.reviewerSubjectId)).toBe(2,
    );
    expect(await sourceGrantCount(backend, fixture.eventId, review.panelMemberId),
    ).toBe(5);
  });

  test("enforces exact-scope ownership and bounded scoped reads", async () => {
    const now = Date.UTC(2027, 6, 8, 9, 10, 11);
    const backend = convexTest(schema, modules);
    const fixture = await seedWriteFixture(backend, now);

    for (let index = 0; index < maximumCurrentGrantsPerPermissionScope; index += 1) {
      await backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.reviewerPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "operations.health.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: `exact-scope-owner-${index}`,
          reason: "Exact scope ceiling fixture",
        }),
      );
    }

    await expect(
      backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.reviewerPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "operations.health.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: "exact-scope-owner-overflow",
          reason: "Exact scope ceiling fixture",
        }),
      ),
    ).rejects.toThrow("exact permission scope has reached");

    for (const scopeId of ["incident-one", "incident-two"]) {
      await backend.run((ctx) =>
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.reviewerPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "incident.read",
          scopeType: "incident",
          scopeId,
          sourceType: "manual",
          sourceId: `incident-owner:${scopeId}`,
          reason: "Bounded scope read fixture",
        }),
      );
    }
    await expect(
      backend.run((ctx) =>
        boundedActivePermissionScopeIds(ctx, {
          eventId: fixture.eventId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "incident.read",
          scopeType: "incident",
          maximumScopeCount: 1,
        }),
      ),
    ).rejects.toThrow("resource limit");
  });
});

async function sourceGrantCount(
  backend: BackendTest,
  eventId: Id<"events">,
  sourceId: Id<"reviewPanelMembers">,
) {
  return backend.run(async (ctx) => {
    const grants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", eventId)
          .eq("sourceType", "panel_assignment")
          .eq("sourceId", sourceId)
          .eq("status", "active"),
      )
      .collect();
    return grants.length;
  });
}

async function activeSourceGrantCount(
  backend: BackendTest,
  eventId: Id<"events">,
  sourceType: "production_seed" | "manual",
  sourceId: string,
) {
  return backend.run(async (ctx) => {
    const grants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", eventId)
          .eq("sourceType", sourceType)
          .eq("sourceId", sourceId)
          .eq("status", "active"),
      )
      .take(maximumCurrentGrantsPerSource + 1);
    return grants.length;
  });
}

async function subjectAccessVersion(backend: BackendTest, subjectId: Id<"eventAccessSubjects">,
) {
  const subject = await backend.run((ctx) => ctx.db.get(subjectId));
  if (!subject) throw new Error("Fixture event access subject is missing.");
  return subject.accessVersion;
}

type WriteFixture = Awaited<ReturnType<typeof seedWriteFixture>>;

async function seedWriteFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `permission-writes-${now}`,
      name: "Permission write fixture",
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
    const reviewer = await insertPerson(ctx, eventId, "reviewer", now);
    const grantor = await insertPerson(ctx, eventId, "grantor", now);
    return {
      eventId,
      reviewerPersonId: reviewer.personId,
      reviewerSubjectId: reviewer.subjectId,
      grantorPersonId: grantor.personId,
    };
  });
}

async function seedReviewAssignment(backend: BackendTest, fixture: WriteFixture, now: number,
) {
  return backend.run(async (ctx) => {
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId: fixture.eventId,
      version: 1,
      name: "Fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "fixture-rubric",
      createdByPersonId: fixture.grantorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: fixture.eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Fixture round",
      sequence: 1,
      status: "published",
      startsAt: now,
      endsAt: now + 3_600_000,
      reviewerReportAt: now - 30_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 3_600_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 3,
      staffing: {
        seniorSeats: 2,
        juniorSeats: 0,
        allowSeniorLeadFallback: true,
        automaticReplacement: false,
        juniorRotationReviews: 0,
        reviewerArrivalSeconds: 90,
        assignmentReminderSeconds: 300,
        assignmentReminderCalls: true,
      },
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: true,
      requiresFinalComment: false,
      minimumReviewerBuild: 1,
      requiresCamera: true,
      requiresNotifications: true,
      version: 1,
      configurationChecksum: "fixture-round",
      createdByPersonId: fixture.grantorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId: fixture.eventId,
      roundId,
      stableKey: "fixture-panel",
      name: "Fixture panel",
      coordinatorPersonId: fixture.reviewerPersonId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
      eventId: fixture.eventId,
      roundId,
      panelId,
      personId: fixture.reviewerPersonId,
      eventAccessSubjectId: fixture.reviewerSubjectId,
      assignedCriterionIds: [],
      isCoordinator: false,
      status: "active",
      assignedAt: now,
      seatSeniority: "sc",
    });
    return { roundId, panelId, panelMemberId };
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
