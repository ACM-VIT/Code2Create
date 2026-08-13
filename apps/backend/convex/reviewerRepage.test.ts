import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("reviewer repaging", () => {
  afterEach(() => vi.restoreAllMocks());

  test.each([
    {
      label: "60-second",
      responseWindowMs: 60_000,
      reminderOffsets: [30_000],
      scheduledCount: 1,
    },
    {
      label: "90-second",
      responseWindowMs: 90_000,
      reminderOffsets: [30_000, 60_000],
      scheduledCount: 3,
    },
  ])(
    "$label page creates every valid reminder once and none at expiry",
    async ({ responseWindowMs, reminderOffsets, scheduledCount }) => {
      const backend = convexTest(schema, modules);
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const pageId = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `repage-${crypto.randomUUID()}`,
        name: "Repage fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        startsAt: now - 1_000,
        endsAt: now + 600_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const coordinatorPersonId = await ctx.db.insert("people", {
        authUserId: crypto.randomUUID(),
        googleSubject: crypto.randomUUID(),
        verifiedEmail: "coordinator@example.test",
        displayName: "Coordinator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const targetPersonId = await ctx.db.insert("people", {
        authUserId: crypto.randomUUID(),
        googleSubject: crypto.randomUUID(),
        verifiedEmail: "reserve@example.test",
        displayName: "Reserve",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const targetSubjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId: targetPersonId,
        emailNormalized: "reserve@example.test",
        displayName: "Reserve",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
        eventId,
        version: 1,
        name: "Rubric",
        status: "published",
        scoreMinimum: 0,
        scoreMaximum: 4,
        aggregationFormula: "criterion_mean_weighted_v1",
        spreadThreshold: 2,
        checksum: "rubric-checksum",
        createdByPersonId: coordinatorPersonId,
        createdAt: now,
        publishedAt: now,
      });
      const criterionId = await ctx.db.insert("reviewRubricCriteria", {
        eventId,
        rubricVersionId,
        stableKey: "quality",
        label: "Quality",
        question: "How strong is the work?",
        guidance: "Assess the demonstrated work.",
        weight: 1,
        displayOrder: 0,
        anchors: { zero: "0", one: "1", two: "2", three: "3", four: "4" },
        createdAt: now,
      });
      const roundId = await ctx.db.insert("reviewRounds", {
        eventId,
        rubricVersionId,
        stableKey: "final",
        name: "Final",
        sequence: 1,
        status: "open",
        startsAt: now - 1_000,
        endsAt: now + 600_000,
        clockInOpensAt: now - 61_000,
        reviewerReportAt: now - 31_000,
        noShowGraceSeconds: 30,
        correctionRequestsCloseAt: now + 600_000,
        reviewDurationSeconds: 600,
        ordinaryExtensionSeconds: 120,
        maximumOrdinaryExtensions: 1,
        missedCallGraceSeconds: 60,
        requiredCallAttempts: 1,
        substituteResponseSeconds: 300,
        missedReentryPolicy: "queue_end",
        requiredPanelSize: 1,
        minimumScorersPerCriterion: 1,
        minimumPresentParticipants: 1,
        requiresSharedCommitments: false,
        minimumReviewerBuild: 1,
        requiresCamera: true,
        requiresNotifications: true,
        version: 1,
        configurationChecksum: "round-checksum",
        createdByPersonId: coordinatorPersonId,
        createdAt: now,
        publishedAt: now,
        openedAt: now,
      });
      const panelId = await ctx.db.insert("reviewPanels", {
        eventId,
        roundId,
        stableKey: "panel_a",
        name: "Panel A",
        coordinatorPersonId,
        status: "needs_reviewer",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const missingSubjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId: coordinatorPersonId,
        emailNormalized: "coordinator@example.test",
        displayName: "Coordinator",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const missingPanelMemberId = await ctx.db.insert("reviewPanelMembers", {
        eventId,
        roundId,
        panelId,
        personId: coordinatorPersonId,
        eventAccessSubjectId: missingSubjectId,
        assignedCriterionIds: [criterionId],
        isCoordinator: true,
        status: "removed",
        assignedAt: now,
        endedAt: now,
      });
      const reserveId = await ctx.db.insert("reviewRoundReserves", {
        eventId,
        roundId,
        personId: targetPersonId,
        eventAccessSubjectId: targetSubjectId,
        status: "paged",
        pageCount: 1,
        lastPagedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const pageChainId = await ctx.db.insert("reviewerPageChains", {
        eventId,
        roundId,
        panelId,
        missingPanelMemberId,
        requiredCriterionIds: [criterionId],
        reason: "Fixture vacancy",
        responseWindowSeconds: 300,
        state: "active",
        currentRank: 1,
        version: 1,
        createdByPersonId: coordinatorPersonId,
        pageGrantIds: [],
        assignmentGrantIds: [],
        resolvedScopeType: "panel",
        resolvedScopeId: panelId,
        createdAt: now,
      });
      const reviewerDeviceId = await ctx.db.insert("reviewerDevices", {
        eventId,
        personId: targetPersonId,
        installationId: crypto.randomUUID(),
        name: "Reserve phone",
        platform: "android",
        appBuild: 1,
        cameraReady: true,
        encryptedDraftReady: true,
        pushToken: "fixture-push-token",
        pushTokenFingerprint: "fixture-push-fingerprint",
        pushProvider: "fcm",
        pushEnvironment: "development",
        pushTokenStatus: "active",
        pushTokenUpdatedAt: now,
        status: "active",
        version: 1,
        registeredAt: now,
        lastSeenAt: now,
      });
      const insertedPageId = await ctx.db.insert("reviewerPages", {
        eventId,
        roundId,
        panelId,
        pageChainId,
        targetPersonId,
        targetEventAccessSubjectId: targetSubjectId,
        reserveId,
        requiredCriterionIds: [criterionId],
        rank: 1,
        reason: "Fixture vacancy",
        state: "sent",
        expiresAt: now + responseWindowMs,
        version: 1,
        createdAt: now,
      });
      await ctx.db.insert("reviewerPushDeliveries", {
        eventId,
        pageId: insertedPageId,
        targetPersonId,
        reviewerDeviceId,
        purpose: "substitute_page",
        logicalAttempt: 1,
        tokenFingerprint: "fixture-push-fingerprint",
        state: "provider_accepted",
        attemptCount: 1,
        providerMessageId: "provider-message-1",
        version: 2,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
      return insertedPageId;
      });

      for (const [index, offset] of reminderOffsets.entries()) {
        clock.mockReturnValue(now + offset);
        const request = { pageId, logicalAttempt: index + 2 };
        await backend.mutation(internal.reviewSubstitutions.repage, request);
        await backend.mutation(internal.reviewSubstitutions.repage, request);
      }
      clock.mockReturnValue(now + responseWindowMs);
      await backend.mutation(internal.reviewSubstitutions.repage, {
        pageId,
        logicalAttempt: reminderOffsets.length + 2,
      });

      const deliveries = await backend.run((ctx) =>
        ctx.db
          .query("reviewerPushDeliveries")
          .withIndex("by_page", (index) => index.eq("pageId", pageId))
          .collect(),
      );
      expect(deliveries).toHaveLength(reminderOffsets.length + 1);
      expect(deliveries.map((delivery) => delivery.logicalAttempt).sort()).toEqual(
        Array.from({ length: reminderOffsets.length + 1 }, (_, index) => index + 1),
      );
      expect(deliveries.find((delivery) => delivery.logicalAttempt === 1)).toMatchObject({
        state: "provider_accepted",
        providerMessageId: "provider-message-1",
      });
      for (let logicalAttempt = 2; logicalAttempt <= reminderOffsets.length + 1; logicalAttempt += 1) {
        expect(deliveries.find((delivery) => delivery.logicalAttempt === logicalAttempt)).toMatchObject({
          state: "pending",
          attemptCount: 0,
        });
      }
      const scheduled = await backend.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled).toHaveLength(scheduledCount);

      const historicalDeliveryId = await backend.run(async (ctx) => {
        const source = deliveries[0];
        if (!source) throw new Error("The page has no source delivery.");
        return ctx.db.insert("reviewerPushDeliveries", {
          eventId: source.eventId,
          pageId: source.pageId,
          targetPersonId: source.targetPersonId,
          reviewerDeviceId: source.reviewerDeviceId,
          purpose: "substitute_page",
          state: "pending",
          attemptCount: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      });
      await expect(
        backend.mutation(internal.reviewPushState.claimDelivery, {
          deliveryId: historicalDeliveryId,
          attemptId: crypto.randomUUID(),
        }),
      ).resolves.toBeNull();
      const historicalDelivery = await backend.run((ctx) => ctx.db.get(historicalDeliveryId));
      expect(historicalDelivery).toMatchObject({
        state: "failed",
        providerErrorCode: "delivery_attempt_missing",
        completedAt: expect.any(Number),
      });
    },
  );
});
