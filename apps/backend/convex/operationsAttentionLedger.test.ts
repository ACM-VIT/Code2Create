import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedFloor>>;

const minute = 60 * 1_000;
/** The clear delay is 90 seconds, so two sweeps a minute apart span it. */
const clearDelayMs = 90 * 1_000;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;
const originalHandbookSiteUrl = process.env.HANDBOOK_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
  restoreEnvironment("HANDBOOK_SITE_URL", originalHandbookSiteUrl);
});

describe("operations attention ledger", () => {
  test("opens once, keeps its identity while it persists, and resolves when it clears", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);

    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const opened = await items(backend, fixture);
    expect(opened).toHaveLength(1);
    const first = opened[0];
    if (!first) throw new Error("The sweep opened no item.");
    expect(first).toMatchObject({
      detectorKey: "panel_seat_empty",
      dedupeKey: `panel_seat_empty:${fixture.panelId}`,
      state: "open",
      severity: "critical",
      recurrenceCount: 1,
      version: 1,
    });
    expect(first.statement).toContain("Panel D is short one reviewer");
    expect(first.firstObservedAt).toBe(first.lastObservedAt);

    // The condition persists: the same row is updated, never duplicated.
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const persisted = await items(backend, fixture);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?._id).toBe(first._id);
    expect(persisted[0]?.state).toBe("open");
    expect(persisted[0]?.version).toBe(2);
    expect(persisted[0]?.firstObservedAt).toBe(first.firstObservedAt);
    expect(persisted[0]?.clearedSince).toBeUndefined();

    // The seat is filled. One sweep records that it cleared but does not resolve.
    await fillTheSeat(backend, fixture);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const clearing = await items(backend, fixture);
    expect(clearing[0]?.state).toBe("open");
    expect(clearing[0]?.clearedSince).toEqual(expect.any(Number));

    // Past the clear delay it resolves, and that resolution is the memory the
    // recomputed list never had.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + clearDelayMs + 1_000);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const resolved = await items(backend, fixture);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.state).toBe("resolved");
    expect(resolved[0]?.resolvedAt).toEqual(expect.any(Number));
    expect(resolved[0]?.clearedSince).toBeUndefined();
  });

  test("a condition that comes back opens a fresh item that counts the recurrence", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);

    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    await fillTheSeat(backend, fixture);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + minute);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    vi.setSystemTime(Date.now() + clearDelayMs + 1_000);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    expect((await items(backend, fixture))[0]?.state).toBe("resolved");

    // The same seat empties again.
    await emptyTheSeat(backend, fixture);
    vi.setSystemTime(Date.now() + 2 * minute);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});

    const rows = await items(backend, fixture);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state).sort()).toEqual(["open", "resolved"]);
    const reopened = rows.find((row) => row.state === "open");
    expect(reopened?.recurrenceCount).toBe(2);
    expect(reopened?.dedupeKey).toBe(`panel_seat_empty:${fixture.panelId}`);
  });

  test("an acknowledgement survives re-detection and is never overwritten by the sweep", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});

    const before = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(before.summary).toMatchObject({ rowCount: 1, criticalCount: 1, acknowledgedCount: 0 });
    const row = before.rows[0];
    if (!row) throw new Error("The overview returned no row.");

    await operator.mutation(api.operationsAttention.acknowledge, {
      eventSlug: fixture.eventSlug,
      itemId: row.id,
      expectedVersion: row.version,
    });

    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const after = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.acknowledged).toBe(true);
    expect(after.summary.acknowledgedCount).toBe(1);

    const audit = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect(),
    );
    expect(audit.filter((entry) => entry.action === "operations.attention_item_acknowledged"))
      .toHaveLength(1);
  });

  test("a stale acknowledgement is refused rather than applied to a changed row", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const row = (
      await operator.query(api.operationsAttention.overview, { eventSlug: fixture.eventSlug })
    ).rows[0];
    if (!row) throw new Error("The overview returned no row.");

    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    await expect(
      operator.mutation(api.operationsAttention.acknowledge, {
        eventSlug: fixture.eventSlug,
        itemId: row.id,
        expectedVersion: row.version,
      }),
    ).rejects.toThrow("Refresh before continuing");
  });

  test("a dismissed row leaves the board but the sweep keeps its evidence current", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const row = (
      await operator.query(api.operationsAttention.overview, { eventSlug: fixture.eventSlug })
    ).rows[0];
    if (!row) throw new Error("The overview returned no row.");

    await operator.mutation(api.operationsAttention.dismiss, {
      eventSlug: fixture.eventSlug,
      itemId: row.id,
      expectedVersion: row.version,
      reason: "The third seat is deliberately empty for this round.",
    });

    const board = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(board.rows).toHaveLength(0);

    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});
    const rows = await items(backend, fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("dismissed");
    expect(rows[0]?.lastObservedAt).toEqual(expect.any(Number));
  });

  test("a row only reaches a caller who can open the workspace it links to", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});

    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    const board = await onlooker.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(board.rows).toHaveLength(0);

    const hidden = (await items(backend, fixture))[0];
    if (!hidden) throw new Error("The sweep opened no item to hide.");
    await expect(
      onlooker.mutation(api.operationsAttention.acknowledge, {
        eventSlug: fixture.eventSlug,
        itemId: hidden._id,
        expectedVersion: hidden.version,
      }),
    ).rejects.toThrow("permission");
  });

  test("canAct follows the command grant behind the proposal, not the ability to look", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    await openTheVacancy(backend, fixture);
    await backend.mutation(internal.operationsAttentionSweep.sweepReviewDomain, {});

    const withCommand = await asOperator(backend, fixture).query(
      api.operationsAttention.overview,
      { eventSlug: fixture.eventSlug },
    );
    const row = withCommand.rows.find((entry) => entry.detectorKey === "panel_seat_empty");
    expect(row?.canAct).toBe(true);
    expect(row?.proposal?.commandName).toBe("reviewSubstitutions.startPageChain");
    expect(JSON.parse(row?.proposal?.argsJson ?? "{}")).toMatchObject({
      eventSlug: fixture.eventSlug,
      missingPanelMemberId: fixture.removedPanelMemberId,
      expectedPanelVersion: 2,
    });

    const reader = backend.withIdentity({
      subject: fixture.readerAuthUserId,
      sessionId: fixture.readerAuthSessionId,
    });
    const looking = await reader.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(looking.rows).toHaveLength(1);
    expect(looking.rows[0]?.canAct).toBe(false);
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

async function items(backend: BackendTest, fixture: Fixture) {
  return backend.run(async (ctx) =>
    ctx.db
      .query("operationsAttentionItems")
      .withIndex("by_event_dedupe", (index) => index.eq("eventId", fixture.eventId))
      .collect(),
  );
}

/** Clocks the third reviewer in, so the panel is no longer short. */
async function fillTheSeat(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    const clockIn = await ctx.db
      .query("reviewerClockIns")
      .withIndex("by_round_person", (index) =>
        index.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.absentPersonId),
      )
      .unique();
    if (!clockIn) throw new Error("The fixture reviewer has no clock-in.");
    await ctx.db.patch(clockIn._id, { status: "present", version: clockIn.version + 1 });
  });
}

async function emptyTheSeat(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    const clockIn = await ctx.db
      .query("reviewerClockIns")
      .withIndex("by_round_person", (index) =>
        index.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.absentPersonId),
      )
      .unique();
    if (!clockIn) throw new Error("The fixture reviewer has no clock-in.");
    await ctx.db.patch(clockIn._id, { status: "clocked_out", version: clockIn.version + 1 });
  });
}

/**
 * Removes the seat outright, which is the state `startPageChain` requires and
 * therefore the only state in which the item may carry that proposal.
 */
async function openTheVacancy(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    await ctx.db.patch(fixture.removedPanelMemberId, {
      status: "removed",
      endedAt: Date.now(),
    });
    await ctx.db.patch(fixture.panelId, { status: "needs_reviewer", version: 2 });
  });
}

/**
 * A live round with one panel that is short a reviewer and one team queued
 * behind it: the smallest floor on which every state transition is observable.
 */
async function seedFloor(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `attention-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now, "operator");
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const onlookerAuthUserId = await createAuthUser(backend, now, "onlooker");
  const onlookerAuthSessionId = await createAuthSession(backend, onlookerAuthUserId, now);
  const readerAuthUserId = await createAuthUser(backend, now, "reader");
  const readerAuthSessionId = await createAuthSession(backend, readerAuthUserId, now);

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Attention fixture",
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
    const onlooker = await insertAccount(ctx, eventId, "onlooker", now, onlookerAuthUserId);
    const reader = await insertAccount(ctx, eventId, "reader", now, readerAuthUserId);

    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "fixture-rubric",
      createdByPersonId: operator.personId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Review 1",
      sequence: 1,
      status: "open",
      startsAt: now - 60 * minute,
      endsAt: now + 60 * minute,
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
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "fixture-round",
      createdByPersonId: operator.personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const coordinator = await insertAccount(ctx, eventId, "coordinator", now);
    const seated = await insertAccount(ctx, eventId, "seated", now);
    const absent = await insertAccount(ctx, eventId, "absent", now);
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "fixture-panel",
      name: "Panel D",
      coordinatorPersonId: coordinator.personId,
      status: "ready",
      version: 1,
      createdAt: now - 90 * minute,
      // Well past the one-minute persistence threshold, so the first sweep sees it.
      updatedAt: now - 90 * minute,
    });
    const panelMemberIds: Id<"reviewPanelMembers">[] = [];
    for (const [key, account] of [
      ["coordinator", coordinator],
      ["seated", seated],
      ["absent", absent],
    ] as const) {
      panelMemberIds.push(
        await ctx.db.insert("reviewPanelMembers", {
          eventId,
          roundId,
          panelId,
          personId: account.personId,
          eventAccessSubjectId: account.subjectId,
          assignedCriterionIds: [],
          isCoordinator: key === "coordinator",
          status: "active",
          assignedAt: now,
        }),
      );
      const deviceId = await ctx.db.insert("reviewerDevices", {
        eventId,
        personId: account.personId,
        installationId: `${key}-${crypto.randomUUID()}`,
        name: `${key} phone`,
        platform: "android",
        appBuild: 1,
        cameraReady: true,
        encryptedDraftReady: true,
        pushTokenStatus: "active",
        pushTokenUpdatedAt: now,
        status: "active",
        version: 1,
        registeredAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("reviewerClockIns", {
        eventId,
        roundId,
        reviewerPersonId: account.personId,
        reviewerDeviceId: deviceId,
        // The third seat is the one nobody is sitting in.
        status: key === "absent" ? "clocked_out" : "present",
        clockedInAt: now - 30 * minute,
        lastHeartbeatAt: now,
        version: 1,
      });
    }

    const participant = await insertAccount(ctx, eventId, "participant", now);
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
      name: "Nightshift",
      publicCode: "NIGHT1",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("attendanceTeamAvailability", {
      eventId,
      teamId,
      activeMemberCount: 3,
      insideMemberCount: 3,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.insert("teamRoundStates", {
      eventId,
      roundId,
      teamId,
      panelId,
      state: "queued",
      queuedAt: now - 2 * minute,
      callAttemptCount: 0,
      priority: 0,
      version: 1,
      updatedByPersonId: operator.personId,
      updatedAt: now - 2 * minute,
    });

    for (const account of [operator, reader]) {
      for (const permissionKey of ["operations.health.read", "operations.attention.manage"] as const) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId: account.personId,
          eventAccessSubjectId: account.subjectId,
          permissionKey,
          scopeType: "event",
          sourceType: "manual",
          sourceId: `${eventSlug}:${permissionKey}:${account.personId}`,
          grantedByPersonId: operator.personId,
          reason: "Attention ledger test",
        });
      }
      await insertPermissionGrant(ctx, {
        eventId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: roundId,
        sourceType: "manual",
        sourceId: `${eventSlug}:round.read:${account.personId}`,
        grantedByPersonId: operator.personId,
        reason: "Attention ledger test",
      });
    }
    // Only the operator can actually run the fix the proposal names.
    await insertPermissionGrant(ctx, {
      eventId,
      personId: operator.personId,
      eventAccessSubjectId: operator.subjectId,
      permissionKey: "review.substitute.page",
      scopeType: "panel",
      scopeId: panelId,
      sourceType: "manual",
      sourceId: `${eventSlug}:review.substitute.page`,
      grantedByPersonId: operator.personId,
      reason: "Attention ledger test",
    });
    // The onlooker may see the dashboard but holds no grant on this round.
    await insertPermissionGrant(ctx, {
      eventId,
      personId: onlooker.personId,
      eventAccessSubjectId: onlooker.subjectId,
      permissionKey: "operations.health.read",
      scopeType: "event",
      sourceType: "manual",
      sourceId: `${eventSlug}:operations.health.read:onlooker`,
      grantedByPersonId: operator.personId,
      reason: "Attention ledger test",
    });

    const removedPanelMemberId = panelMemberIds[2];
    if (!removedPanelMemberId) throw new Error("The fixture panel has no third seat.");
    return {
      eventSlug,
      eventId,
      roundId,
      panelId,
      removedPanelMemberId,
      absentPersonId: absent.personId,
      authUserId,
      authSessionId,
      onlookerAuthUserId,
      onlookerAuthSessionId,
      readerAuthUserId,
      readerAuthSessionId,
    };
  });
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

async function createAuthUser(backend: BackendTest, now: number, key: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `Attention ${key}`,
        email: `attention-${key}-${crypto.randomUUID()}@example.test`,
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

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
