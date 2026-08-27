import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant, type GrantSource } from "./lib/permissions.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits.ts";
import { insertTeamRoundState } from "./lib/reviewQueueProjection.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedPanel>>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
});

describe("live panel membership", () => {
  test("shows a setup-to-board link only for a round the operator can read", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);
    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey: "review.configuration.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:review.configuration.read`,
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Review setup link test",
      });
    });

    const setupWithoutRoundAccess = await operator.query(api.reviewConfiguration.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(setupWithoutRoundAccess.rounds).toEqual([
      expect.objectContaining({ id: fixture.roundId, canReadBoard: false }),
    ]);

    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: fixture.roundId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:round.read`,
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Review setup link test",
      });
    });

    const setupWithRoundAccess = await operator.query(api.reviewConfiguration.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(setupWithRoundAccess.rounds[0]?.canReadBoard).toBe(true);
  });

  test("moves the seat, its grants, and the reserve to the joining reviewer", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    const result = await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-once",
    });
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2 });

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      const leaving = members.find((member) => member.personId === fixture.memberPersonId);
      const joining = members.find((member) => member.personId === fixture.reservePersonId);
      expect(leaving?.status).toBe("replaced");
      expect(joining?.status).toBe("active");
      expect(joining?.isCoordinator).toBe(false);
      expect(joining?.assignedCriterionIds).toEqual(leaving?.assignedCriterionIds);
      expect(members.filter((member) => member.status === "active")).toHaveLength(3);

      const panel = await ctx.db.get(fixture.panelId);
      expect(panel?.coordinatorPersonId).toBe(fixture.coordinatorPersonId);

      const reserve = await ctx.db.get(fixture.reserveId);
      expect(reserve?.status).toBe("assigned");

      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      expect(audit.filter((entry) => entry.action === "review.panel_membership_changed"))
        .toHaveLength(1);
    });

    expect(await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", fixture.memberId))
      .toBe(0);
    expect(await activeSourceGrantCount(backend, fixture.eventId, "reserve_assignment", fixture.reserveId))
      .toBe(0);
    const joiningMemberId = await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .collect();
      const joining = members.find((member) => member.personId === fixture.reservePersonId);
      if (!joining) throw new Error("The joining panel member is missing.");
      return joining._id;
    });
    expect(await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", joiningMemberId))
      .toBe(5);
  });

  test("refuses to change a panel while a review is live on it", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await seedLiveReview(backend, fixture);
    const operator = asOperator(backend, fixture);

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.memberPersonId,
        joiningPersonId: fixture.reservePersonId,
        expectedPanelVersion: 1,
        reason: "The seated reviewer went home ill.",
        clientOperationId: "swap-during-review",
      }),
    ).rejects.toThrow("A review is live at this panel");

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      expect(members.filter((member) => member.status === "active")).toHaveLength(3);
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({ version: 1 });
    });
  });

  test("refuses a stale expected panel version", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-first",
    });

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.secondMemberPersonId,
        expectedPanelVersion: 1,
        reason: "A second desk was looking at the old board.",
        clientOperationId: "swap-stale",
      }),
    ).rejects.toThrow("Refresh before continuing");
  });

  test("replays one client operation without writing a second time", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    const request = {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-replayed",
    } as const;
    const first = await operator.mutation(api.reviewPanelMembership.swapPanelMember, request);
    expect(await operator.mutation(api.reviewPanelMembership.swapPanelMember, request)).toEqual(first);

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      expect(members).toHaveLength(4);
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({ version: 2 });
      expect(
        await ctx.db
          .query("operationResults")
          .withIndex("by_actor_operation", (index) =>
            index
              .eq("actorPersonId", fixture.operatorPersonId)
              .eq("clientOperationId", request.clientOperationId),
          )
          .collect(),
      ).toHaveLength(1);
      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      expect(audit.filter((entry) => entry.action === "review.panel_membership_changed"))
        .toHaveLength(1);
    });
  });

  test("refuses to leave the panel without the reviewer who runs it", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.coordinatorPersonId,
        expectedPanelVersion: 1,
        reason: "The coordinator has to leave the hall.",
        clientOperationId: "remove-coordinator",
      }),
    ).rejects.toThrow("cannot lose the reviewer who runs it");

    const result = await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.coordinatorPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The coordinator has to leave the hall.",
      clientOperationId: "replace-coordinator",
    });
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2 });
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({
        coordinatorPersonId: fixture.reservePersonId,
      });
    });
  });

  test("rejects a team code from a different displayed review", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const displayedSessionId = await seedLiveReview(backend, fixture);
    const scannedSessionId = await seedLiveReview(backend, fixture);
    const payload = `c2c-review-v1.${"a".repeat(64)}`;

    await backend.run(async (ctx) => {
      await ctx.db.patch(displayedSessionId, { status: "awaiting_presence" });
      await ctx.db.patch(scannedSessionId, { status: "awaiting_presence" });
      const scannedSession = await ctx.db.get(scannedSessionId);
      if (!scannedSession) throw new Error("The scanned review session is missing.");
      const team = await ctx.db.get(scannedSession.teamId);
      if (!team) throw new Error("The scanned review team is missing.");
      await ctx.db.insert("reviewTeamQrTokens", {
        eventId: fixture.eventId,
        reviewSessionId: scannedSessionId,
        teamId: team._id,
        tokenDigest: bytesToHex(sha256(utf8ToBytes(payload))),
        manualCodeDigest: bytesToHex(sha256(utf8ToBytes("ABCDEFGHJKLM"))),
        tokenVersion: 1,
        state: "active",
        expiresAt: Date.now() + 120_000,
        issuedByMembershipId: team.leadMembershipId,
        issuedAt: Date.now(),
      });
    });

    await expect(
      asOperator(backend, fixture).mutation(api.reviewer.confirmPresence, {
        eventSlug: fixture.eventSlug,
        clientOperationId: "different-review-presence",
        installationId: crypto.randomUUID(),
        reviewSessionId: displayedSessionId,
        payload,
      }),
    ).rejects.toThrow("different review");

    await backend.run(async (ctx) => {
      expect(
        await ctx.db
          .query("reviewPresence")
          .withIndex("by_session_reviewer", (index) =>
            index.eq("reviewSessionId", scannedSessionId),
          )
          .collect(),
      ).toHaveLength(0);
    });
  });

  test("reviewer duty and active paging stay inside the requested event", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const installationId = crypto.randomUUID();
    await backend.run(async (ctx) => {
      const now = Date.now();
      const foreignEventId = await ctx.db.insert("events", {
        slug: `foreign-review-${crypto.randomUUID()}`,
        name: "Foreign review fixture",
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
      const roundId = await ctx.db.insert("reviewRounds", {
        eventId: foreignEventId,
        rubricVersionId: fixture.rubricVersionId,
        stableKey: "foreign_round",
        name: "Foreign round",
        sequence: 1,
        status: "open",
        startsAt: now - 60_000,
        endsAt: now + 3_600_000,
        clockInOpensAt: now - 120_000,
        reviewerReportAt: now - 90_000,
        noShowGraceSeconds: 30,
        correctionRequestsCloseAt: now + 3_600_000,
        reviewDurationSeconds: 600,
        ordinaryExtensionSeconds: 120,
        maximumOrdinaryExtensions: 1,
        missedCallGraceSeconds: 120,
        requiredCallAttempts: 2,
        substituteResponseSeconds: 60,
        missedReentryPolicy: "preserve_queue_time",
        requiredPanelSize: 1,
        minimumScorersPerCriterion: 1,
        minimumPresentParticipants: 1,
        requiresSharedCommitments: false,
        minimumReviewerBuild: 1,
        requiresCamera: false,
        requiresNotifications: false,
        version: 1,
        configurationChecksum: "foreign-round",
        createdByPersonId: fixture.operatorPersonId,
        createdAt: now,
        publishedAt: now,
        openedAt: now,
      });
      const panelId = await ctx.db.insert("reviewPanels", {
        eventId: foreignEventId,
        roundId,
        stableKey: "foreign_panel",
        name: "Foreign panel",
        coordinatorPersonId: fixture.operatorPersonId,
        status: "ready",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
        eventId: foreignEventId,
        roundId,
        panelId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        assignedCriterionIds: [],
        isCoordinator: true,
        status: "active",
        assignedAt: now,
      });
      const reserveId = await ctx.db.insert("reviewRoundReserves", {
        eventId: foreignEventId,
        roundId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        status: "paged",
        pageCount: 1,
        lastPagedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const pageChainId = await ctx.db.insert("reviewerPageChains", {
        eventId: foreignEventId,
        roundId,
        panelId,
        missingPanelMemberId: panelMemberId,
        requiredCriterionIds: [],
        reason: "Foreign vacancy",
        responseWindowSeconds: 60,
        state: "active",
        currentRank: 1,
        version: 1,
        createdByPersonId: fixture.operatorPersonId,
        pageGrantIds: [],
        assignmentGrantIds: [],
        resolvedScopeType: "panel",
        resolvedScopeId: panelId,
        createdAt: now,
      });
      await ctx.db.insert("reviewerPages", {
        eventId: foreignEventId,
        roundId,
        panelId,
        pageChainId,
        targetPersonId: fixture.operatorPersonId,
        targetEventAccessSubjectId: fixture.operatorSubjectId,
        reserveId,
        requiredCriterionIds: [],
        rank: 1,
        reason: "Foreign vacancy",
        state: "sent",
        expiresAt: now + 60_000,
        version: 1,
        createdAt: now,
      });
      await ctx.db.insert("reviewerDevices", {
        eventId: foreignEventId,
        personId: fixture.operatorPersonId,
        installationId,
        name: "Foreign reviewer phone",
        platform: "android",
        appBuild: 1,
        cameraReady: true,
        encryptedDraftReady: true,
        pushTokenStatus: "not_registered",
        pushTokenUpdatedAt: now,
        status: "active",
        version: 1,
        registeredAt: now,
        lastSeenAt: now,
      });
    });

    const operator = asOperator(backend, fixture);
    await expect(
      operator.query(api.reviewer.dutyStatus, {
        eventSlug: fixture.eventSlug,
        installationId,
      }),
    ).resolves.toEqual({
      deviceRegistered: false,
      panelAssigned: false,
      clockInStatus: null,
      heartbeat: null,
      review: null,
    });
    await expect(
      operator.query(api.reviewSubstitutions.currentPage, { eventSlug: fixture.eventSlug }),
    ).resolves.toBeNull();
  });

  test("keeps reviewer setup usable while revoked read grants hide assigned work", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);

    await backend.run(async (ctx) => {
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_source", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("sourceType", "panel_assignment")
            .eq("sourceId", fixture.memberId)
            .eq("status", "active"),
        )
        .collect();
      const panelReadGrant = grants.find((grant) => grant.permissionKey === "panel.read");
      if (!panelReadGrant) throw new Error("The panel-read fixture grant is missing.");
      await ctx.db.patch(panelReadGrant._id, {
        status: "revoked",
        revokedAt: Date.now(),
        revokedByPersonId: fixture.operatorPersonId,
        revokeReason: "Reviewer projection boundary test",
      });
      const memberSubject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", fixture.eventId).eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!memberSubject) throw new Error("The panel member subject is missing.");
      const pageChainId = await ctx.db.insert("reviewerPageChains", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        missingPanelMemberId: fixture.memberId,
        requiredCriterionIds: [],
        reason: "Projection boundary vacancy",
        responseWindowSeconds: 60,
        state: "active",
        currentRank: 1,
        version: 1,
        createdByPersonId: fixture.operatorPersonId,
        pageGrantIds: [],
        assignmentGrantIds: [],
        resolvedScopeType: "panel",
        resolvedScopeId: fixture.panelId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("reviewerPages", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        pageChainId,
        targetPersonId: fixture.memberPersonId,
        targetEventAccessSubjectId: memberSubject._id,
        reserveId: fixture.reserveId,
        requiredCriterionIds: [],
        rank: 1,
        reason: "Projection boundary vacancy",
        state: "sent",
        expiresAt: Date.now() + 60_000,
        version: 1,
        createdAt: Date.now(),
      });
    });

    await expect(
      reviewer.identity.query(api.access.reviewerCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ reviews: true });
    await expect(
      reviewer.identity.query(api.reviewer.dutyStatus, {
        eventSlug: fixture.eventSlug,
        installationId: reviewer.installationId,
      }),
    ).resolves.toEqual({
      deviceRegistered: true,
      panelAssigned: false,
      clockInStatus: null,
      heartbeat: null,
      review: null,
    });
    await expect(
      reviewer.identity.query(api.reviewer.now, {
        eventSlug: fixture.eventSlug,
        installationId: reviewer.installationId,
      }),
    ).resolves.toMatchObject({
      device: { name: "Availability test phone" },
      panel: null,
      reserve: null,
      review: null,
    });
    await expect(
      reviewer.identity.query(api.reviewSubstitutions.currentPage, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toBeNull();
  });

  test("refuses to move another team into a full panel queue", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewSessionId = await seedLiveReview(backend, fixture);
    const { sourceStateId, targetPanelId } = await backend.run(async (ctx) => {
      const now = Date.now();
      const session = await ctx.db.get(reviewSessionId);
      if (!session) throw new Error("The queue-capacity fixture review is missing.");
      const targetPanelId = await ctx.db.insert("reviewPanels", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        stableKey: "full_target_panel",
        name: "Full target panel",
        coordinatorPersonId: fixture.coordinatorPersonId,
        status: "ready",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const sourceStateId = await insertTeamRoundState(ctx, {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        teamId: session.teamId,
        panelId: fixture.panelId,
        state: "queued",
        queuedAt: now,
        callAttemptCount: 0,
        priority: 0,
        version: 1,
        updatedByPersonId: fixture.operatorPersonId,
        updatedAt: now,
      });
      for (let index = 0; index < maximumReviewTeamsPerEvent; index += 1) {
        await insertTeamRoundState(ctx, {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          teamId: session.teamId,
          panelId: targetPanelId,
          state: "queued",
          queuedAt: now + index,
          callAttemptCount: 0,
          priority: 0,
          version: 1,
          updatedByPersonId: fixture.operatorPersonId,
          updatedAt: now + index,
        });
      }
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey: "review.queue.move",
        scopeType: "team",
        scopeId: session.teamId,
        sourceType: "manual",
        sourceId: "queue-capacity-move",
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Queue-capacity test",
      });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey: "queue.manage",
        scopeType: "panel",
        scopeId: targetPanelId,
        sourceType: "manual",
        sourceId: "queue-capacity-target",
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Queue-capacity test",
      });
      return { sourceStateId, targetPanelId };
    });

    await expect(
      asOperator(backend, fixture).mutation(api.reviewExceptions.moveQueuedTeam, {
        eventSlug: fixture.eventSlug,
        teamRoundStateId: sourceStateId,
        targetPanelId,
        expectedVersion: 1,
        reason: "Move to the other panel",
        clientOperationId: "move-into-full-panel",
      }),
    ).rejects.toThrow(`at most ${maximumReviewTeamsPerEvent} teams`);
  });

  test("clock-in opens at the exact published boundary and a rejected attempt writes nothing", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await setReviewerTiming(backend, fixture.roundId, boundary);
    const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(boundary - 60_001);
      await expect(
        reviewer.identity.mutation(api.reviewer.clockIn, {
          eventSlug: fixture.eventSlug,
          roundId: fixture.roundId,
          installationId: reviewer.installationId,
          expectedVersion: 0,
          clientOperationId: "clock-in-before-opening",
        }),
      ).rejects.toThrow("Clock-in is available only from the published opening");
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId)).toEqual(before);

      clock.mockReturnValue(boundary - 60_000);
      await expect(
        reviewer.identity.mutation(api.reviewer.clockIn, {
          eventSlug: fixture.eventSlug,
          roundId: fixture.roundId,
          installationId: reviewer.installationId,
          expectedVersion: 0,
          clientOperationId: "clock-in-at-opening",
        }),
      ).resolves.toMatchObject({ version: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  test("clock-in rejects a reviewer outside declared availability without writes", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await setReviewerTiming(backend, fixture.roundId, boundary);
    await backend.run(async (ctx) => {
      const profile = await ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", fixture.eventId).eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!profile) throw new Error("The reviewer profile is missing.");
      await ctx.db.patch(profile._id, {
        availabilityWindows: [{ startsAt: boundary - 3_600_000, endsAt: boundary - 60_001 }],
        version: profile.version + 1,
      });
    });
    const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId);
    const clock = vi.spyOn(Date, "now").mockReturnValue(boundary - 60_000);
    try {
      await expect(
        reviewer.identity.mutation(api.reviewer.clockIn, {
          eventSlug: fixture.eventSlug,
          roundId: fixture.roundId,
          installationId: reviewer.installationId,
          expectedVersion: 0,
          clientOperationId: "clock-in-outside-availability",
        }),
      ).rejects.toThrow("current availability no longer covers");
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId)).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  test("no-show is rejected before and accepted at the exact grace boundary", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    await Promise.all([
      setReviewerTiming(backend, fixture.roundId, boundary),
      grantNoShow(backend, fixture),
    ]);
    const operator = asOperator(backend, fixture);
    const before = await reviewerPolicySnapshot(backend, fixture, null);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(boundary - 1);
      await expect(
        operator.mutation(api.reviewSubstitutions.markNoShow, {
          eventSlug: fixture.eventSlug,
          panelMemberId: fixture.memberId,
          expectedPanelVersion: 1,
          expectedClockInVersion: 0,
          reason: "Reviewer did not arrive.",
          clientOperationId: "no-show-before-boundary",
        }),
      ).rejects.toThrow("grace period has not ended");
      expect(await reviewerPolicySnapshot(backend, fixture, null)).toEqual(before);

      clock.mockReturnValue(boundary);
      await expect(
        operator.mutation(api.reviewSubstitutions.markNoShow, {
          eventSlug: fixture.eventSlug,
          panelMemberId: fixture.memberId,
          expectedPanelVersion: 1,
          expectedClockInVersion: 0,
          reason: "Reviewer did not arrive.",
          clientOperationId: "no-show-at-boundary",
        }),
      ).resolves.toMatchObject({ panelVersion: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  test("a present reviewer cannot be marked no-show and the failure is atomic", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await Promise.all([
      setReviewerTiming(backend, fixture.roundId, boundary),
      grantNoShow(backend, fixture),
    ]);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(boundary - 60_000);
      await reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 0,
        clientOperationId: "present-reviewer-clock-in",
      });
      const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId);

      clock.mockReturnValue(boundary);
      await expect(
        asOperator(backend, fixture).mutation(api.reviewSubstitutions.markNoShow, {
          eventSlug: fixture.eventSlug,
          panelMemberId: fixture.memberId,
          expectedPanelVersion: 1,
          expectedClockInVersion: 1,
          reason: "Desk believed the reviewer was absent.",
          clientOperationId: "present-reviewer-no-show",
        }),
      ).rejects.toThrow("A reviewer who is present cannot be marked as a no-show");
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId)).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  test("simultaneous clock-in and no-show resolve to exactly one versioned state", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await Promise.all([
      setReviewerTiming(backend, fixture.roundId, boundary),
      grantNoShow(backend, fixture),
    ]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(boundary);
    try {
      const results = await Promise.allSettled([
        reviewer.identity.mutation(api.reviewer.clockIn, {
          eventSlug: fixture.eventSlug,
          roundId: fixture.roundId,
          installationId: reviewer.installationId,
          expectedVersion: 0,
          clientOperationId: "racing-clock-in",
        }),
        asOperator(backend, fixture).mutation(api.reviewSubstitutions.markNoShow, {
          eventSlug: fixture.eventSlug,
          panelMemberId: fixture.memberId,
          expectedPanelVersion: 1,
          expectedClockInVersion: 0,
          reason: "Reviewer did not arrive.",
          clientOperationId: "racing-no-show",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await backend.run(async (ctx) => {
        const [member, panel, clockIn] = await Promise.all([
          ctx.db.get(fixture.memberId),
          ctx.db.get(fixture.panelId),
          ctx.db
            .query("reviewerClockIns")
            .withIndex("by_round_person", (index) =>
              index.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.memberPersonId),
            )
            .unique(),
        ]);
        if (member?.status === "active") {
          expect(panel).toMatchObject({ status: "ready", version: 1 });
          expect(clockIn).toMatchObject({ status: "present", version: 1 });
        } else {
          expect(member?.status).toBe("removed");
          expect(panel).toMatchObject({ status: "needs_reviewer", version: 2 });
          expect(clockIn).toBeNull();
        }
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("round publication rejects an unavailable reviewer without partial records", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const startsAt = Date.now() + 60 * 60_000;
    await preparePublicationPolicy(backend, fixture);
    await backend.run(async (ctx) => {
      const profile = await ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", fixture.eventId).eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!profile) throw new Error("The reviewer profile is missing.");
      await ctx.db.patch(profile._id, {
        availabilityWindows: [{ startsAt: startsAt - 3_600_000, endsAt: startsAt - 60_001 }],
        version: profile.version + 1,
      });
    });
    const before = await publicationSnapshot(backend, fixture.eventId);
    await expect(
      asOperator(backend, fixture).mutation(api.reviewConfiguration.publishRound, {
        eventSlug: fixture.eventSlug,
        rubric: {
          name: "Availability fixture rubric",
          spreadThreshold: 2,
          criteria: [{
            stableKey: "craft",
            label: "Craft",
            question: "How strong is the demonstrated craft?",
            guidance: "Use only the fixed evidence shown by the team.",
            weight: 100,
            displayOrder: 0,
            anchors: { zero: "None", one: "Weak", two: "Sound", three: "Strong", four: "Exceptional" },
          }],
        },
        round: {
          stableKey: "availability_fixture_round",
          name: "Availability fixture round",
          sequence: 2,
          clockInOpensAt: startsAt - 60_000,
          reviewerReportAt: startsAt - 30_000,
          startsAt,
          endsAt: startsAt + 3_600_000,
          noShowGraceSeconds: 30,
          correctionRequestsCloseAt: startsAt + 3_600_000,
          reviewDurationSeconds: 600,
          ordinaryExtensionSeconds: 120,
          maximumOrdinaryExtensions: 1,
          missedCallGraceSeconds: 120,
          requiredCallAttempts: 2,
          substituteResponseSeconds: 60,
          missedReentryPolicy: "preserve_queue_time",
          requiredPanelSize: 1,
          minimumScorersPerCriterion: 1,
          minimumPresentParticipants: 1,
          requiresSharedCommitments: true,
          minimumReviewerBuild: 1,
          requiresCamera: false,
          requiresNotifications: false,
        },
        panels: [{
          stableKey: "availability_panel",
          name: "Availability panel",
          members: [{
            personId: fixture.memberPersonId,
            criterionKeys: ["craft"],
            isCoordinator: true,
          }],
        }],
        reservePersonIds: [],
        reason: "Exercise unavailable reviewer publication",
        clientOperationId: "publish-unavailable-reviewer",
      }),
    ).rejects.toThrow("is not available from clock-in opening through the round end");
    expect(await publicationSnapshot(backend, fixture.eventId)).toEqual(before);
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "reviewQueue");
  return backend;
}

function asOperator(backend: BackendTest, fixture: Fixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

async function prepareReviewerClockIn(backend: BackendTest, fixture: Fixture) {
  const now = Date.now();
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const installationId = crypto.randomUUID();
  await backend.run(async (ctx) => {
    await ctx.db.patch(fixture.memberPersonId, { authUserId, updatedAt: now });
    await ctx.db.insert("reviewerDevices", {
      eventId: fixture.eventId,
      personId: fixture.memberPersonId,
      installationId,
      name: "Availability test phone",
      platform: "android",
      appBuild: 1,
      cameraReady: true,
      encryptedDraftReady: true,
      pushTokenStatus: "not_registered",
      pushTokenUpdatedAt: now,
      status: "active",
      version: 1,
      registeredAt: now,
      lastSeenAt: now,
    });
  });
  return {
    installationId,
    identity: backend.withIdentity({ subject: authUserId, sessionId: authSessionId }),
  };
}

async function setReviewerTiming(
  backend: BackendTest,
  roundId: Id<"reviewRounds">,
  noShowBoundary: number,
) {
  await backend.run(async (ctx) => {
    const round = await ctx.db.get(roundId);
    if (!round) throw new Error("The reviewer timing fixture round is missing.");
    await ctx.db.patch(round._id, {
      clockInOpensAt: noShowBoundary - 60_000,
      reviewerReportAt: noShowBoundary - 30_000,
      startsAt: noShowBoundary,
      endsAt: noShowBoundary + 60 * 60_000,
      noShowGraceSeconds: 30,
      version: round.version + 1,
    });
  });
}

async function grantNoShow(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.operatorPersonId,
      eventAccessSubjectId: fixture.operatorSubjectId,
      permissionKey: "review.reviewer.no_show",
      scopeType: "person",
      scopeId: fixture.memberPersonId,
      sourceType: "manual",
      sourceId: `no-show:${fixture.memberPersonId}`,
      grantedByPersonId: fixture.operatorPersonId,
      reason: "Reviewer no-show policy test",
    });
  });
}

async function preparePublicationPolicy(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    const now = Date.now();
    const policy = defaultParticipantPolicy;
    const policyId = await ctx.db.insert("participantPolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      ...policy,
      checksum: participantPolicyChecksum(policy),
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(fixture.eventId, {
      publishedParticipantPolicyId: policyId,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.operatorPersonId,
      eventAccessSubjectId: fixture.operatorSubjectId,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
      sourceType: "manual",
      sourceId: `publish:${fixture.eventId}`,
      grantedByPersonId: fixture.operatorPersonId,
      reason: "Review publication policy test",
    });
  });
}

async function reviewerPolicySnapshot(
  backend: BackendTest,
  fixture: Fixture,
  installationId: string | null,
) {
  return backend.run(async (ctx) => {
    const [member, panel, clockIns, operationResults, auditEvents, device] = await Promise.all([
      ctx.db.get(fixture.memberId),
      ctx.db.get(fixture.panelId),
      ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.memberPersonId),
        )
        .collect(),
      ctx.db
        .query("operationResults")
        .collect()
        .then((rows) => rows.filter((row) => row.eventId === fixture.eventId)),
      ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect(),
      installationId === null
        ? Promise.resolve(null)
        : ctx.db
            .query("reviewerDevices")
            .withIndex("by_event_installation", (index) =>
              index.eq("eventId", fixture.eventId).eq("installationId", installationId),
            )
            .unique(),
    ]);
    return {
      member: member && { status: member.status, endedAt: member.endedAt },
      panel: panel && { status: panel.status, version: panel.version, updatedAt: panel.updatedAt },
      clockIns: clockIns.map((clockIn) => ({
        id: clockIn._id,
        status: clockIn.status,
        version: clockIn.version,
        lastHeartbeatAt: clockIn.lastHeartbeatAt,
      })),
      operationResultIds: operationResults.map((result) => result._id),
      auditEventIds: auditEvents.map((event) => event._id),
      device: device && { version: device.version, lastSeenAt: device.lastSeenAt },
    };
  });
}

async function publicationSnapshot(backend: BackendTest, eventId: Id<"events">) {
  return backend.run(async (ctx) => {
    const [
      rubrics,
      criteria,
      rounds,
      panels,
      members,
      reserves,
      grants,
      operations,
      audits,
    ] = await Promise.all([
      ctx.db.query("reviewRubricVersions").withIndex("by_event_version", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("reviewRubricCriteria").collect().then((rows) => rows.filter((row) => row.eventId === eventId)),
      ctx.db.query("reviewRounds").withIndex("by_event_status_start", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("reviewPanels").withIndex("by_event_name", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("reviewPanelMembers").withIndex("by_event_person_status", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("reviewRoundReserves").withIndex("by_event_person_status", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("permissionGrants").withIndex("by_event_permission_status", (index) => index.eq("eventId", eventId)).collect(),
      ctx.db.query("operationResults").collect().then((rows) => rows.filter((row) => row.eventId === eventId)),
      ctx.db.query("auditEvents").withIndex("by_event_time", (index) => index.eq("eventId", eventId)).collect(),
    ]);
    return {
      rubrics: rubrics.map((row) => row._id),
      criteria: criteria.map((row) => row._id),
      rounds: rounds.map((row) => row._id),
      panels: panels.map((row) => row._id),
      members: members.map((row) => row._id),
      reserves: reserves.map((row) => row._id),
      grants: grants.map((row) => row._id),
      operations: operations.map((row) => row._id),
      audits: audits.map((row) => row._id),
    };
  });
}

async function activeSourceGrantCount(
  backend: BackendTest,
  eventId: Id<"events">,
  sourceType: GrantSource,
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
      .collect();
    return grants.length;
  });
}

async function seedPanel(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `panel-membership-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Panel membership fixture",
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
    const criterionKeys = ["craft", "impact"];
    const reviewers = new Map<string, { personId: Id<"people">; subjectId: Id<"eventAccessSubjects"> }>();
    for (const key of ["coordinator", "member", "second-member", "reserve"]) {
      const account = await insertAccount(ctx, eventId, key, now);
      await ctx.db.insert("reviewerProfiles", {
        eventId,
        personId: account.personId,
        technicalDomains: ["backend"],
        productDomains: ["operations"],
        languages: ["english"],
        criterionKeys,
        availabilityWindows: [{ startsAt: now - 2 * 60 * 60 * 1_000, endsAt: now + 4 * 60 * 60 * 1_000 }],
        trainingStatus: "complete",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      reviewers.set(key, account);
    }
    const coordinator = requireReviewer(reviewers, "coordinator");
    const member = requireReviewer(reviewers, "member");
    const secondMember = requireReviewer(reviewers, "second-member");
    const reserve = requireReviewer(reviewers, "reserve");

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
    const criterionIds: Id<"reviewRubricCriteria">[] = [];
    for (const [index, stableKey] of criterionKeys.entries()) {
      criterionIds.push(
        await ctx.db.insert("reviewRubricCriteria", {
          eventId,
          rubricVersionId,
          stableKey,
          label: `Criterion ${stableKey}`,
          question: `How strong is the ${stableKey}?`,
          guidance: "Score what the team showed.",
          weight: 1,
          displayOrder: index,
          anchors: { zero: "0", one: "1", two: "2", three: "3", four: "4" },
          createdAt: now,
        }),
      );
    }
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Fixture round",
      sequence: 1,
      status: "open",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      clockInOpensAt: now - 120_000,
      reviewerReportAt: now - 90_000,
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
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "fixture-panel",
      name: "Fixture panel",
      coordinatorPersonId: coordinator.personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const panelMemberIds = new Map<string, Id<"reviewPanelMembers">>();
    for (const [key, account] of [
      ["coordinator", coordinator],
      ["member", member],
      ["second-member", secondMember],
    ] as const) {
      const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
        eventId,
        roundId,
        panelId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        assignedCriterionIds: criterionIds,
        isCoordinator: key === "coordinator",
        status: "active",
        assignedAt: now,
      });
      panelMemberIds.set(key, panelMemberId);
      for (const permissionKey of ["reviewer.clock_in", "round.read"] as const) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId: account.personId,
          eventAccessSubjectId: account.subjectId,
          permissionKey,
          scopeType: "round",
          scopeId: roundId,
          sourceType: "panel_assignment",
          sourceId: panelMemberId,
          grantedByPersonId: operator.personId,
          reason: "Published review panel assignment",
        });
      }
      await insertPermissionGrant(ctx, {
        eventId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKey: "panel.read",
        scopeType: "panel",
        scopeId: panelId,
        sourceType: "panel_assignment",
        sourceId: panelMemberId,
        grantedByPersonId: operator.personId,
        reason: "Published review panel assignment",
      });
    }
    const reserveId = await ctx.db.insert("reviewRoundReserves", {
      eventId,
      roundId,
      personId: reserve.personId,
      eventAccessSubjectId: reserve.subjectId,
      status: "available",
      pageCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["reviewer.clock_in", "round.read"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: reserve.personId,
        eventAccessSubjectId: reserve.subjectId,
        permissionKey,
        scopeType: "round",
        scopeId: roundId,
        sourceType: "reserve_assignment",
        sourceId: reserveId,
        grantedByPersonId: operator.personId,
        reason: "Published reserve reviewer assignment",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId: operator.personId,
      eventAccessSubjectId: operator.subjectId,
      permissionKey: "review.substitute.assign",
      scopeType: "panel",
      scopeId: panelId,
      sourceType: "manual",
      sourceId: `${eventSlug}:review.substitute.assign`,
      grantedByPersonId: operator.personId,
      reason: "Panel membership test",
    });
    const memberId = panelMemberIds.get("member");
    if (!memberId) throw new Error("The fixture panel member is missing.");
    return {
      eventSlug,
      eventId,
      roundId,
      panelId,
      rubricVersionId,
      memberId,
      operatorPersonId: operator.personId,
      operatorSubjectId: operator.subjectId,
      coordinatorPersonId: coordinator.personId,
      memberPersonId: member.personId,
      secondMemberPersonId: secondMember.personId,
      reservePersonId: reserve.personId,
      reserveId,
      authUserId,
      authSessionId,
    };
  });
}

async function seedLiveReview(backend: BackendTest, fixture: Fixture) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const participant = await insertAccount(ctx, fixture.eventId, "participant", now);
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: fixture.eventId,
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
      eventId: fixture.eventId,
      name: "Fixture team",
      publicCode: "FIXT01",
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
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      label: "Fixture participant policy",
      teamMinimumSize: 1,
      teamMaximumSize: 4,
      mixedParticipantClassesAllowed: true,
      phoneField: "not_collected",
      vitRegistrationNumberField: "required",
      vitProgrammeField: "not_collected",
      vitCampusField: "not_collected",
      externalCityField: "not_collected",
      externalCountryField: "not_collected",
      profileNotice: "Fixture profile notice.",
      projectTextNotice: "Fixture project notice.",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "Fixture attestation.",
      finalSubmissionWarning: "Fixture warning.",
      checksum: "fixture-participant-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      openingText: "Fixture opening.",
      initialPrompt: "Describe the idea.",
      initialHelpText: "Fixture help.",
      initialIdeaMinLength: 10,
      initialIdeaMaxLength: 500,
      followUpAnswerMinLength: 10,
      followUpAnswerMaxLength: 500,
      minimumFollowUpCount: 0,
      maximumFollowUpCount: 3,
      deterministicFollowUpCount: 3,
      questionMaxLength: 200,
      allowedPurposeKeys: [],
      fallbackQuestions: [],
      blockedTerms: [],
      commonIdeaPatterns: [],
      model: { mode: "deterministic" },
      checksum: "fixture-intake-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", {
      eventId: fixture.eventId,
      version: "1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "fixture-admission-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId: fixture.eventId,
      teamId,
      teamMemberIds: [],
      intakePolicyVersionId,
      participantPolicyVersionId,
      admissionPolicyVersionId,
      submittedAt: now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: fixture.eventId,
      teamId,
      version: 1,
      initialIdea: "A fixture project idea.",
      intakePolicyVersionId,
      intakeResponses: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 0,
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId,
      admissionPolicyVersionId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    const evidenceCheckpointSetId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      roundSequence: 1,
      teamId,
      projectVersionId,
      githubEntries: [],
      figmaEntries: [],
      expectedResourceCount: 0,
      capturedResourceCount: 0,
      completeness: "complete",
      checksum: "fixture-evidence",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
    });
    return ctx.db.insert("reviewSessions", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.panelId,
      teamId,
      projectVersionId,
      evidenceCheckpointSetId,
      rubricVersionId: fixture.rubricVersionId,
      panelVersion: 1,
      status: "active",
      startedAt: now,
      plannedEndAt: now + 600_000,
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 1,
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function requireReviewer(
  reviewers: Map<string, { personId: Id<"people">; subjectId: Id<"eventAccessSubjects"> }>,
  key: string,
) {
  const account = reviewers.get(key);
  if (!account) throw new Error(`The fixture reviewer ${key} is missing.`);
  return account;
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
        name: "Panel operator",
        email: `panel-operator-${crypto.randomUUID()}@example.test`,
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
