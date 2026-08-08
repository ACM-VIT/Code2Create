import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import { grantPanelMemberAccess } from "./lib/reviewAccess.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
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
    expect(await subjectAccessVersion(backend, fixture.reviewerSubjectId)).toBe(2);
    expect(await sourceGrantCount(backend, fixture.eventId, review.panelMemberId)).toBe(4);

    await backend.run((ctx) => grantPanelMemberAccess(ctx, args));
    expect(await subjectAccessVersion(backend, fixture.reviewerSubjectId)).toBe(2);
    expect(await sourceGrantCount(backend, fixture.eventId, review.panelMemberId)).toBe(4);
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

async function subjectAccessVersion(
  backend: BackendTest,
  subjectId: Id<"eventAccessSubjects">,
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

async function seedReviewAssignment(
  backend: BackendTest,
  fixture: WriteFixture,
  now: number,
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
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 3,
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: true,
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
      tableLabel: "A1",
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
