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
const clearDelayMs = 90 * 1_000;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
});

describe("operations attention ledger", () => {
  test("opens once, keeps its identity while it persists, and resolves when it clears", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
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

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const persisted = await items(backend, fixture);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?._id).toBe(first._id);
    expect(persisted[0]?.state).toBe("open");
    expect(persisted[0]?.version).toBe(1);
    expect(persisted[0]?.firstObservedAt).toBe(first.firstObservedAt);
    expect(persisted[0]?.lastObservedAt).toBe(first.lastObservedAt);
    expect(persisted[0]?.clearedSince).toBeUndefined();

    await fillTheSeat(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const clearing = await items(backend, fixture);
    expect(clearing[0]?.state).toBe("open");
    expect(clearing[0]?.clearedSince).toEqual(expect.any(Number));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + clearDelayMs + 1_000);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const resolved = await items(backend, fixture);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.state).toBe("resolved");
    expect(resolved[0]?.resolvedAt).toEqual(expect.any(Number));
    expect(resolved[0]?.clearedSince).toBeUndefined();
  });

  test("a condition that comes back opens a fresh item that counts the recurrence", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    await fillTheSeat(backend, fixture);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + minute);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    vi.setSystemTime(Date.now() + clearDelayMs + 1_000);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    expect((await items(backend, fixture))[0]?.state).toBe("resolved");

    await emptyTheSeat(backend, fixture);
    vi.setSystemTime(Date.now() + 2 * minute);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );

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
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );

    const before = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(before.summary).toMatchObject({ rowCount: 1, criticalCount: 1, acknowledgedCount: 0,
    });
    const row = before.rows[0];
    if (!row) throw new Error("The overview returned no row.");

    const acknowledgeCommand = {
      eventSlug: fixture.eventSlug,
      itemId: row.id,
      expectedVersion: row.version,
      clientOperationId: "attention-acknowledge-survives",
    };
    const acknowledgement = await operator.mutation(
      api.operationsAttention.acknowledge,
      acknowledgeCommand,
    );
    await expect(
      operator.mutation(api.operationsAttention.acknowledge, acknowledgeCommand,
      ),
    ).resolves.toEqual(acknowledgement);

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const after = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.acknowledged).toBe(true);
    expect(after.summary.acknowledgedCount).toBe(1);

    const audit = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId),
        )
        .collect(),
    );
    expect(
      audit.filter((entry) => entry.action === "operations.attention_item_acknowledged",
      ),
    ).toHaveLength(1);
  });

  test("a stale acknowledgement is refused after the detector output changes", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const row = (
      await operator.query(api.operationsAttention.overview, { eventSlug: fixture.eventSlug,
      })
    ).rows[0];
    if (!row) throw new Error("The overview returned no row.");

    await openTheVacancy(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    await expect(
      operator.mutation(api.operationsAttention.acknowledge, {
        eventSlug: fixture.eventSlug,
        itemId: row.id,
        expectedVersion: row.version,
        clientOperationId: "stale-attention-acknowledgement",
      }),
    ).rejects.toThrow("Refresh before continuing");
  });

  test("an unchanged re-detection does not make an operator action stale", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const row = (
      await operator.query(api.operationsAttention.overview, { eventSlug: fixture.eventSlug,
      })
    ).rows[0];
    if (!row) throw new Error("The overview returned no row.");

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    await expect(
      operator.mutation(api.operationsAttention.acknowledge, {
        eventSlug: fixture.eventSlug,
        itemId: row.id,
        expectedVersion: row.version,
        clientOperationId: "unchanged-attention-acknowledgement",
      }),
    ).resolves.toEqual({ version: row.version + 1 });
  });

  test("only one reconciliation can commit from a discovered sweep version", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const target = (
      await backend.query(internal.operationsAttentionSweep.reviewDomainTargets, {},
      )
    ).find((candidate) => candidate.roundId === fixture.roundId);
    if (!target) throw new Error("The dispatcher did not discover the fixture round.");
    const now = Date.now() + 1;
    const observed = (await items(backend, fixture))
      .filter(
        (item) =>
          item.roundId === target.roundId &&
          (item.state === "open" || item.state === "acknowledged" || item.state === "dismissed"),
      )
      .map((item) => ({
        detectorKey: item.detectorKey,
        dedupeKey: item.dedupeKey,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        severity: item.severity,
        statement: item.statement,
        route: item.route,
        actionLabel: item.actionLabel,
        visibility: item.visibility,
        evidenceJson: item.evidenceJson,
        ...(item.proposal === undefined ? {} : { proposal: item.proposal }),
      }));
    const request = { ...target, observed, now };

    await expect(
      backend.mutation(internal.operationsAttentionSweep.reconcileReviewRound, request,
      ),
    ).resolves.toBe("applied");
    await expect(
      backend.mutation(internal.operationsAttentionSweep.reconcileReviewRound, request,
      ),
    ).resolves.toBe("stale");
    expect((await items(backend, fixture))[0]).toMatchObject({ state: "open", version: 1,
    });
  });

  test("a dismissed row leaves the board but the sweep keeps its evidence current", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const row = (
      await operator.query(api.operationsAttention.overview, { eventSlug: fixture.eventSlug,
      })
    ).rows[0];
    if (!row) throw new Error("The overview returned no row.");

    const dismissCommand = {
      eventSlug: fixture.eventSlug,
      itemId: row.id,
      expectedVersion: row.version,
      reason: "The third seat is deliberately empty for this round.",
      clientOperationId: "attention-dismissal-survives",
    };
    const dismissal = await operator.mutation(api.operationsAttention.dismiss, dismissCommand,
    );
    await expect(
      operator.mutation(api.operationsAttention.dismiss, dismissCommand),
    ).resolves.toEqual(dismissal);

    const board = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(board.rows).toHaveLength(0);

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const rows = await items(backend, fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("dismissed");
    expect(rows[0]?.lastObservedAt).toEqual(expect.any(Number));
  });

  test("a row only reaches a caller who can open the workspace it links to", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );

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
        clientOperationId: "hidden-attention-acknowledgement",
      }),
    ).rejects.toThrow("permission");
  });

  test("the overview returns the exact highest-priority window and discloses overflow", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const source = (await items(backend, fixture))[0];
    if (!source) throw new Error("The sweep opened no source item.");

    await backend.run(async (ctx) => {
      for (let index = 0; index < 20; index += 1) {
        await ctx.db.insert("operationsAttentionItems", {
          eventId: source.eventId,
          roundId: fixture.roundId,
          detectorKey: "panel_seat_empty",
          dedupeKey: `priority-window:${index}`,
          subjectType: "panel",
          subjectId: `priority-panel:${index}`,
          severity: "critical",
          statement: `Priority condition ${index}`,
          route: source.route,
          actionLabel: source.actionLabel,
          visibility: source.visibility,
          evidenceJson: "{}",
          state: "open",
          recurrenceCount: 1,
          firstObservedAt: source.firstObservedAt - (20 - index) * minute,
          lastObservedAt: source.lastObservedAt,
          version: 1,
        });
      }
      for (let index = 0; index < 5; index += 1) {
        await ctx.db.insert("operationsAttentionItems", {
          eventId: source.eventId,
          roundId: fixture.roundId,
          detectorKey: "round_finish_forecast",
          dedupeKey: `watch-window:${index}`,
          subjectType: "round",
          subjectId: `watch-round:${index}`,
          severity: "watch",
          statement: `Watch condition ${index}`,
          route: source.route,
          actionLabel: source.actionLabel,
          visibility: source.visibility,
          evidenceJson: "{}",
          state: "open",
          recurrenceCount: 1,
          firstObservedAt: source.firstObservedAt - 24 * 60 * minute,
          lastObservedAt: source.lastObservedAt,
          version: 1,
        });
      }
    });

    const overview = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(overview.summary).toMatchObject({
      limit: 20,
      hasMore: true,
      rowCount: 20,
      criticalCount: 20,
      watchCount: 0,
    });
    expect(overview.rows).toHaveLength(20);
    expect(overview.rows.every((row) => row.severity === "critical")).toBe(true,
    );
    expect(overview.rows.map((row) => row.statement)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `Priority condition ${index}`,
      ),
    );
  });

  test("historical rows without a round owner cannot re-enter live workflows", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const operator = asOperator(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const source = (await items(backend, fixture))[0];
    if (!source) throw new Error("The sweep opened no source item.");
    const historicalId = await backend.run((ctx) =>
      ctx.db.insert("operationsAttentionItems", {
        eventId: source.eventId,
        detectorKey: source.detectorKey,
        dedupeKey: `${source.dedupeKey}:historical`,
        subjectType: source.subjectType,
        subjectId: source.subjectId,
        severity: source.severity,
        statement: source.statement,
        route: source.route,
        actionLabel: source.actionLabel,
        visibility: source.visibility,
        evidenceJson: source.evidenceJson,
        state: "open",
        recurrenceCount: 1,
        firstObservedAt: source.firstObservedAt,
        lastObservedAt: source.lastObservedAt,
        version: 1,
      }),
    );

    const overview = await operator.query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    });
    expect(overview.rows.map((row) => row.id)).not.toContain(historicalId);
    const intelligence = await backend.query(internal.intelligenceReads.operationsAttentionRead, {
      eventId: fixture.eventId,
      now: Date.now(),
    },
    );
    expect(intelligence.items.map((item) => item.itemId)).not.toContain(historicalId,
    );
    await expect(
      operator.mutation(api.operationsAttention.acknowledge, {
        eventSlug: fixture.eventSlug,
        itemId: historicalId,
        expectedVersion: 1,
        clientOperationId: "historical-attention-acknowledgement",
      }),
    ).rejects.toThrow("unavailable");
  });

  test("canAct follows the command grant behind the proposal, not the ability to look", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    await openTheVacancy(backend, fixture);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );

    const withCommand = await asOperator(backend, fixture).query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    },
    );
    const row = withCommand.rows.find((entry) => entry.detectorKey === "panel_seat_empty",
    );
    expect(row?.canAct).toBe(true);
    expect(row?.proposal?.command).toMatchObject({
      name: "reviewSubstitutions.startPageChain",
      missingPanelMemberId: fixture.removedPanelMemberId,
      expectedPanelVersion: 2,
    });

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const unchanged = await asOperator(backend, fixture).query(api.operationsAttention.overview, {
      eventSlug: fixture.eventSlug,
    },
    );
    expect(unchanged.rows[0]).toMatchObject({
      id: row?.id,
      version: row?.version,
      canAct: true,
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

  test("reconciles rounds independently and resolves a closed round's leftovers", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const second = await addShortRound(backend, fixture);

    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const opened = await items(backend, fixture);
    expect(opened).toHaveLength(2);
    expect(opened.map((item) => item.roundId).sort()).toEqual(
      [fixture.roundId, second.roundId].sort(),
    );

    await backend.run((ctx) => ctx.db.patch(second.roundId, { status: "closed" }),
    );
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const clearing = await items(backend, fixture);
    expect(clearing.find((item) => item.roundId === fixture.roundId),
    ).toMatchObject({
      state: "open",
      version: 1,
    });
    expect(clearing.find((item) => item.roundId === second.roundId),
    ).toMatchObject({
      state: "open",
      clearedSince: expect.any(Number),
      version: 2,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + clearDelayMs + 1_000);
    await backend.action(internal.operationsAttentionSweep.sweepReviewDomain, {},
    );
    const resolved = await items(backend, fixture);
    expect(resolved.find((item) => item.roundId === fixture.roundId),
    ).toMatchObject({
      state: "open",
      version: 1,
    });
    expect(resolved.find((item) => item.roundId === second.roundId),
    ).toMatchObject({
      state: "resolved",
      version: 3,
    });
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
      .withIndex("by_event_dedupe", (index) => index.eq("eventId", fixture.eventId),
      )
      .collect(),
  );
}

async function fillTheSeat(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    await ctx.db.patch(fixture.removedPanelMemberId, { status: "active", endedAt: undefined });
  });
}

async function emptyTheSeat(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    await ctx.db.patch(fixture.removedPanelMemberId, { status: "removed", endedAt: Date.now() });
  });
}

async function openTheVacancy(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    await ctx.db.patch(fixture.removedPanelMemberId, {
      status: "removed",
      endedAt: Date.now(),
    });
    await ctx.db.patch(fixture.panelId, { status: "needs_reviewer", version: 2,
    });
  });
}

async function addShortRound(backend: BackendTest, fixture: Fixture) {
  return backend.run(async (ctx) => {
    const now = Date.now();
    const sourceRound = await ctx.db.get(fixture.roundId);
    if (!sourceRound) throw new Error("The fixture review round is missing.");
    const coordinator = await insertAccount(ctx, fixture.eventId, "second-coordinator", now,
    );
    const seated = await insertAccount(ctx, fixture.eventId, "second-seated", now,
    );
    const absent = await insertAccount(ctx, fixture.eventId, "second-absent", now,
    );
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: fixture.eventId,
      rubricVersionId: sourceRound.rubricVersionId,
      stableKey: `second-${crypto.randomUUID()}`,
      name: "Review 2",
      sequence: 2,
      status: "open",
      startsAt: now - 60 * minute,
      endsAt: now + 60 * minute,
      clockInOpensAt: now - 61 * minute,
      reviewerReportAt: now - 60 * minute - 30_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 60 * minute,
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
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: `second-${crypto.randomUUID()}`,
      createdByPersonId: coordinator.personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId: fixture.eventId,
      roundId,
      stableKey: `second-panel-${crypto.randomUUID()}`,
      name: "Panel E",
      coordinatorPersonId: coordinator.personId,
      status: "ready",
      version: 1,
      createdAt: now - 90 * minute,
      updatedAt: now - 90 * minute,
    });

    for (const [key, account] of [
      ["coordinator", coordinator],
      ["seated", seated],
      ["absent", absent],
    ] as const) {
      await ctx.db.insert("reviewPanelMembers", {
        eventId: fixture.eventId,
        roundId,
        panelId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        assignedCriterionIds: [],
        isCoordinator: key === "coordinator",
        status: key === "absent" ? "removed" : "active",
        ...(key === "absent" ? { endedAt: now } : {}),
        assignedAt: now,
        seatSeniority: key === "coordinator" ? "lead" : "sc",
      });
      const deviceId = await ctx.db.insert("reviewerDevices", {
        eventId: fixture.eventId,
        personId: account.personId,
        installationId: `second-${key}-${crypto.randomUUID()}`,
        name: `second ${key} phone`,
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
        eventId: fixture.eventId,
        roundId,
        reviewerPersonId: account.personId,
        reviewerDeviceId: deviceId,
        status: key === "absent" ? "clocked_out" : "present",
        clockedInAt: now - 30 * minute,
        lastHeartbeatAt: now,
        version: 1,
      });
    }
    return { roundId, panelId };
  });
}

async function seedFloor(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `attention-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now, "operator");
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const onlookerAuthUserId = await createAuthUser(backend, now, "onlooker");
  const onlookerAuthSessionId = await createAuthSession(backend, onlookerAuthUserId, now,
  );
  const readerAuthUserId = await createAuthUser(backend, now, "reader");
  const readerAuthSessionId = await createAuthSession(backend, readerAuthUserId, now,
  );

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Attention fixture",
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
    const operator = await insertAccount(ctx, eventId, "operator", now, authUserId,
    );
    const onlooker = await insertAccount(ctx, eventId, "onlooker", now, onlookerAuthUserId,
    );
    const reader = await insertAccount(ctx, eventId, "reader", now, readerAuthUserId,
    );

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
      clockInOpensAt: now - 61 * minute,
      reviewerReportAt: now - 60 * minute - 30_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 60 * minute,
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
          status: key === "absent" ? "removed" : "active",
          ...(key === "absent" ? { endedAt: now } : {}),
          assignedAt: now,
          seatSeniority: key === "coordinator" ? "lead" : "sc",
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
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
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
      for (const permissionKey of [
        "operations.health.read",
        "operations.attention.manage",
      ] as const) {
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
  },
  );
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number,
) {
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
  },
  );
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
