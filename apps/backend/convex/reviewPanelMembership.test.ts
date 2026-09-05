import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import {
  defaultVitHostelResidenceCatalog,
  reviewerCallConsentPolicyVersion,
  reviewerCallScriptPolicyVersion,
} from "@code2create/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { convexTest, type TestConvex } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterAll, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant, type GrantSource } from "./lib/permissions.ts";
import { grantReviewAssignmentAccess } from "./lib/reviewAccess.ts";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy.ts";
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

describe("reviewer shift reminders", () => {
  test("uses the configured lead time and dispatches at most one call for a shift", async () => {
    const f = await shiftReminderFixture(600_000);
    {
      await f.prepare();
      expect(await f.calls()).toHaveLength(0);
      await f.configure(600, true);
      await f.prepare();
      await f.prepare();
      const calls = await f.calls();
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call).toMatchObject({
        purpose: "reviewer_shift_reminder",
        attemptCount: 0,
      });
      expect(call.script).toContain("open the reviewer app");
      const claim = { deliveryId: call._id, attemptId: "first" };
      expect(
        await f.backend.mutation(
          internal.outboundCallState.claimDelivery,
          claim,
        ),
      ).not.toBeNull();
      expect(
        await f.backend.mutation(
          internal.outboundCallState.claimDelivery,
          claim,
        ),
      ).toBeNull();
      await f.prepare();
      expect(await f.calls()).toHaveLength(1);
    }
  });

  test.each([
    "hours",
    "clock_in",
    "calls_off",
    "reminders_off",
    "round_closed",
    "consent",
    "permission",
    "expired",
  ] as const)(
    "cancels a queued call when %s makes it obsolete",
    async (change) => {
      const f = await shiftReminderFixture();
      await f.prepare();
      const [call] = await f.calls();
      if (!call) throw new Error("Reminder missing");
      await f.backend.run(async (ctx) => {
        const round = await ctx.db.get(f.fixture.roundId);
        if (!round) throw new Error("Round missing");
        if (change === "hours")
          await ctx.db.patch(f.confirmationId, { version: 2, windows: [] });
        if (change === "calls_off")
          await ctx.db.patch(round._id, {
            staffing: { ...round.staffing, assignmentReminderCalls: false },
          });
        if (change === "reminders_off")
          await ctx.db.patch(round._id, {
            staffing: { ...round.staffing, assignmentReminderSeconds: 0 },
          });
        if (change === "round_closed")
          await ctx.db.patch(round._id, { status: "closed" });
        if (change === "consent")
          await ctx.db.patch(f.consentId, { state: "revoked", version: 2 });
        if (change === "permission") {
          for (const id of call.authorizationGrantIds)
            await ctx.db.patch(id, { status: "revoked" });
        }
        if (change === "clock_in")
          await ctx.db.insert("reviewerClockIns", {
            eventId: f.fixture.eventId,
            roundId: f.fixture.roundId,
            reviewerPersonId: f.fixture.memberPersonId,
            reviewerDeviceId: f.deviceId,
            status: "present",
            clockedInAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            version: 1,
          });
      });
      const clock =
        change === "expired"
          ? vi.spyOn(Date, "now").mockReturnValue(f.shiftStartsAt)
          : null;
      try {
        expect(
          await f.backend.mutation(internal.outboundCallState.claimDelivery, {
            deliveryId: call._id,
            attemptId: "obsolete",
          }),
        ).toBeNull();
        expect(
          await f.backend.run((ctx) => ctx.db.get(call._id)),
        ).toMatchObject({ state: "cancelled", attemptCount: 0 });
      } finally {
        clock?.mockRestore();
      }
    },
  );

  test("shortening the lead time defers a queued call without consuming a dispatch attempt", async () => {
    const f = await shiftReminderFixture();
    await f.prepare();
    const [call] = await f.calls();
    if (!call) throw new Error("Reminder missing");
    await f.configure(60, true);
    expect(
      await f.backend.mutation(internal.outboundCallState.claimDelivery, {
        deliveryId: call._id,
        attemptId: "early",
      }),
    ).toBeNull();
    expect(await f.backend.run((ctx) => ctx.db.get(call._id))).toMatchObject({
      state: "retry_wait",
      nextAttemptAt: f.shiftStartsAt - 60_000,
      attemptCount: 0,
    });
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(f.shiftStartsAt - 60_000);
    try {
      expect(
        await f.backend.mutation(internal.outboundCallState.claimDelivery, {
          deliveryId: call._id,
          attemptId: "due",
        }),
      ).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test("bringing a deferred reminder forward schedules the same unsent call immediately", async () => {
    const f = await shiftReminderFixture();
    await f.prepare();
    const [call] = await f.calls();
    if (!call) throw new Error("Reminder missing");
    await f.configure(60, true);
    await f.backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: call._id,
      attemptId: "defer",
    });
    const scheduledCalls = () => f.backend.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name === "outboundCalls:deliver",
      ),
    );
    const before = await scheduledCalls();
    await f.configure(300, true);
    await f.prepare();
    expect(await f.calls()).toEqual([
      expect.objectContaining({ _id: call._id, state: "pending", attemptCount: 0 }),
    ]);
    expect((await f.calls())[0]?.nextAttemptAt).toBeUndefined();
    const after = await scheduledCalls();
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.scheduledTime).toBeLessThan(f.shiftStartsAt - 60_000);
    expect(await f.backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: call._id,
      attemptId: "latest-time",
    })).not.toBeNull();
  });

  test("late consent and enabling calls work even after the push was sent", async () => {
    const f = await shiftReminderFixture();
    await f.backend.run((ctx) =>
      ctx.db.patch(f.consentId, {
        consentPolicyVersion: "reviewer-page-call-consent-v1",
      }),
    );
    await f.prepare();
    expect(await f.calls()).toHaveLength(0);
    await f.backend.run(async (ctx) => {
      const notification = await ctx.db
        .query("reviewConfirmationNotifications")
        .unique();
      if (!notification) throw new Error("Push missing");
      await ctx.db.patch(notification._id, { state: "sent" });
    });
    await f.configure(300, false);
    await f.reviewer.identity.mutation(
      api.outboundCallConsents.saveReviewerConsent,
      {
        eventSlug: f.fixture.eventSlug,
        state: "granted",
        consentPolicyVersion: reviewerCallConsentPolicyVersion,
        destinationPhone: "+919000000001",
        expectedVersion: 1,
        clientOperationId: crypto.randomUUID(),
      },
    );
    await f.prepare();
    expect(await f.calls()).toHaveLength(0);
    await f.configure(300, true);
    await f.prepare();
    expect(await f.calls()).toHaveLength(1);
    expect(
      await f.backend.run((ctx) =>
        ctx.db.query("reviewConfirmationNotifications").collect(),
      ),
    ).toEqual([expect.objectContaining({ state: "sent" })]);
  });

  test("clock-in also cancels push delivery", async () => {
    const f = await shiftReminderFixture();
    await f.prepare();
    await f.backend.run((ctx) =>
      ctx.db.insert("reviewerClockIns", {
        eventId: f.fixture.eventId,
        roundId: f.fixture.roundId,
        reviewerPersonId: f.fixture.memberPersonId,
        reviewerDeviceId: f.deviceId,
        status: "present",
        clockedInAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        version: 1,
      }),
    );
    const notification = await f.backend.run((ctx) =>
      ctx.db.query("reviewConfirmationNotifications").unique(),
    );
    if (!notification) throw new Error("Push missing");
    expect(
      await f.backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId: notification._id,
        attemptId: "already-here",
      }),
    ).toBeNull();
    expect(
      await f.backend.run((ctx) => ctx.db.get(notification._id)),
    ).toMatchObject({ state: "cancelled" });
  });
});

async function shiftReminderFixture(leadMs = 240_000) {
  const backend = seededBackend();
  const fixture = await seedPanel(backend);
  const reviewer = await prepareReviewerClockIn(backend, fixture);
  const shiftStartsAt = Date.now() + leadMs;
  const seeded = await backend.run(async (ctx) => {
    const confirmation = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) =>
        q.eq("roundId", fixture.roundId).eq("personId", fixture.memberPersonId),
      )
      .unique();
    const device = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_installation", (q) =>
        q
          .eq("eventId", fixture.eventId)
          .eq("installationId", reviewer.installationId),
      )
      .unique();
    if (!confirmation || !device) throw new Error("Reviewer fixture missing");
    await ctx.db.patch(confirmation._id, {
      windows: [{ startsAt: shiftStartsAt, endsAt: shiftStartsAt + 1_200_000 }],
    });
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.operatorPersonId,
      eventAccessSubjectId: fixture.operatorSubjectId,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
      sourceType: "manual",
      sourceId: "reminder-test-config",
      grantedByPersonId: fixture.operatorPersonId,
      reason: "Configure shift reminders",
    });
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.memberPersonId,
      eventAccessSubjectId: fixture.memberSubjectId,
      permissionKey: "communications.call_consent.manage",
      scopeType: "self",
      scopeId: fixture.memberSubjectId,
      sourceType: "manual",
      sourceId: "reminder-test-consent",
      grantedByPersonId: fixture.operatorPersonId,
      reason: "Reviewer call setting",
    });
    const consentId = await ctx.db.insert("outboundCallConsents", {
      eventId: fixture.eventId,
      personId: fixture.memberPersonId,
      purpose: "reviewer_substitute_page",
      state: "granted",
      destinationPhoneE164: "+919000000001",
      consentPolicyVersion: reviewerCallConsentPolicyVersion,
      scriptPolicyVersion: reviewerCallScriptPolicyVersion,
      version: 1,
      grantedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      confirmationId: confirmation._id,
      consentId,
      deviceId: device._id,
    };
  });
  return {
    backend,
    fixture,
    reviewer,
    shiftStartsAt,
    ...seeded,
    prepare: () =>
      backend.mutation(internal.reviewConfirmations.prepareShiftReminder, {
        confirmationId: seeded.confirmationId,
        confirmationVersion: 1,
        shiftStartsAt,
      }),
    calls: () =>
      backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect()),
    configure: async (seconds: number, calls: boolean) => {
      const round = await backend.run((ctx) => ctx.db.get(fixture.roundId));
      if (!round) throw new Error("Round missing");
      return backend
        .withIdentity({
          subject: fixture.authUserId,
          sessionId: fixture.authSessionId,
        })
        .mutation(api.reviewStaffing.configure, {
          eventSlug: fixture.eventSlug,
          roundId: round._id,
          expectedVersion: round.version,
          staffing: {
            ...round.staffing,
            assignmentReminderSeconds: seconds,
            assignmentReminderCalls: calls,
          },
          substituteResponseSeconds: round.substituteResponseSeconds,
          noShowGraceSeconds: round.noShowGraceSeconds,
          reason: "Change reminder lead time",
          clientOperationId: crypto.randomUUID(),
        });
    },
  };
}

describe("automatic panel staffing", () => {
  test.each(["available", "outside_window", "unconfirmed"] as const)(
    "JC allocation prioritizes a first review only when that JC is eligible (%s)",
    async (availability) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      await prepareAutomaticStaffing(backend, fixture);
      const completedSessionId = await seedLiveReview(backend, fixture);
      const firstTimeReviewerId = await backend.run(async (ctx) => {
        const now = Date.now();
        const round = await ctx.db.get(fixture.roundId);
        const reserve = await ctx.db.get(fixture.reserveId);
        if (!round || !reserve) throw new Error("Staffing fixture missing");
        await ctx.db.patch(round._id, {
          staffing: { ...round.staffing, seniorSeats: 1, juniorSeats: 1 },
        });
        await ctx.db.patch(fixture.memberId, { seatSeniority: "jc" });
        await ctx.db.patch(completedSessionId, {
          status: "completed",
          completedAt: now - 1000,
        });
        await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId: completedSessionId,
          reviewerPersonId: fixture.reservePersonId,
          eventAccessSubjectId: reserve.eventAccessSubjectId,
          assignedCriterionIds: [],
          isCoordinator: false,
          status: "assigned",
          assignedAt: now - 600_000,
        });
        for (const personId of [
          fixture.memberPersonId,
          fixture.reservePersonId,
        ]) {
          const profile = await ctx.db
            .query("reviewerProfiles")
            .withIndex("by_event_person", (q) =>
              q.eq("eventId", fixture.eventId).eq("personId", personId),
            )
            .unique();
          if (!profile) throw new Error("Profile fixture missing");
          await ctx.db.patch(profile._id, { seniority: "jc", strength: 4 });
        }
        const clock = await ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (q) =>
            q
              .eq("roundId", fixture.roundId)
              .eq("reviewerPersonId", fixture.memberPersonId),
          )
          .unique();
        if (!clock) throw new Error("Clock fixture missing");
        await ctx.db.patch(clock._id, {
          status: "temporarily_unavailable",
          expectedReturnAt: now + 600_000,
        });
        const first = await insertAccount(
          ctx,
          fixture.eventId,
          "waiting-for-first-review",
          now,
        );
        await ctx.db.insert("reviewerProfiles", {
          eventId: fixture.eventId,
          personId: first.personId,
          seniority: "jc",
          strength: 0,
          technicalDomains: ["backend"],
          productDomains: [],
          languages: ["English"],
          criterionKeys: ["craft", "impact"],
          trainingStatus: "complete",
          status: "active",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        const deviceId = await ctx.db.insert("reviewerDevices", {
          eventId: fixture.eventId,
          personId: first.personId,
          installationId: crypto.randomUUID(),
          name: "First review phone",
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
        await ctx.db.insert("reviewerClockIns", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          reviewerPersonId: first.personId,
          reviewerDeviceId: deviceId,
          status: "present",
          clockedInAt: now,
          lastHeartbeatAt: now,
          version: 1,
        });
        await ctx.db.insert("reviewRoundReserves", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          personId: first.personId,
          eventAccessSubjectId: first.subjectId,
          status: "available",
          pageCount: 9,
          lastPagedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("reviewerRoundConfirmations", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          personId: first.personId,
          status: availability === "unconfirmed" ? "pending" : "confirmed",
          windows:
            availability === "unconfirmed"
              ? []
              : [
                  {
                    startsAt:
                      availability === "outside_window"
                        ? now + 900_000
                        : now - 60_000,
                    endsAt: now + 1_800_000,
                  },
                ],
          version: 1,
          updatedAt: now,
        });
        return first.personId;
      });
      await backend.mutation(internal.reviewStaffing.checkPanel, {
        panelId: fixture.panelId,
      });
      const pages = await backend.run((ctx) =>
        ctx.db.query("reviewerPages").collect(),
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]?.targetPersonId).toBe(
        availability === "available"
          ? firstTimeReviewerId
          : fixture.reservePersonId,
      );
    },
  );

  test("keeps an active review intact and pages a replacement for its unavailable lead after completion", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await prepareAutomaticStaffing(backend, fixture);
    const reviewSessionId = await seedLiveReview(backend, fixture);
    await backend.run(async (ctx) => {
      const clock = await ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("reviewerPersonId", fixture.coordinatorPersonId),
        )
        .unique();
      if (!clock) throw new Error("Clock fixture missing");
      await ctx.db.patch(clock._id, { status: "clocked_out" });
    });
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    expect(
      await backend.run((ctx) => ctx.db.query("reviewerPages").collect()),
    ).toHaveLength(0);
    expect(
      await backend.run((ctx) => ctx.db.get(fixture.panelId)),
    ).toMatchObject({
      status: "ready",
      version: 1,
    });
    await backend.run((ctx) =>
      ctx.db.patch(reviewSessionId, {
        status: "completed",
        completedAt: Date.now(),
      }),
    );
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    const pages = await backend.run((ctx) =>
      ctx.db.query("reviewerPages").collect(),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      targetPersonId: fixture.reservePersonId,
      state: "sent",
    });
    expect(
      await backend.run((ctx) => ctx.db.get(fixture.panelId)),
    ).toMatchObject({
      status: "needs_reviewer",
      version: 2,
    });
    expect(
      await backend.run((ctx) =>
        ctx.db
          .query("reviewRoundReserves")
          .withIndex("by_round_person", (q) =>
            q
              .eq("roundId", fixture.roundId)
              .eq("personId", fixture.coordinatorPersonId),
          )
          .unique(),
      ),
    ).toMatchObject({ status: "available" });
  });

  test("rotates a JC between reviews only when a qualified JC is available", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await prepareAutomaticStaffing(backend, fixture);
    const sessionId = await seedLiveReview(backend, fixture);
    const memberId = fixture.memberId;
    if (!memberId) throw new Error("Member fixture missing");
    await backend.run(async (ctx) => {
      const round = await ctx.db.get(fixture.roundId);
      if (!round) throw new Error("Round fixture missing");
      await ctx.db.patch(round._id, {
        staffing: {
          ...round.staffing,
          seniorSeats: 1,
          juniorSeats: 1,
          juniorRotationReviews: 1,
        },
      });
      await ctx.db.patch(memberId, { seatSeniority: "jc" });
      const profile = await ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!profile) throw new Error("Profile fixture missing");
      await ctx.db.patch(profile._id, { seniority: "jc" });
      await ctx.db.patch(sessionId, {
        status: "completed",
        completedAt: Date.now(),
      });
    });
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    expect(await backend.run((ctx) => ctx.db.get(memberId))).toMatchObject({
      status: "active",
    });
    await backend.run(async (ctx) => {
      const profile = await ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("personId", fixture.reservePersonId),
        )
        .unique();
      if (!profile) throw new Error("Reserve profile missing");
      await ctx.db.patch(profile._id, { seniority: "jc" });
    });
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    expect(await backend.run((ctx) => ctx.db.get(memberId))).toMatchObject({
      status: "removed",
    });
    expect(
      await backend.run((ctx) => ctx.db.query("reviewerPages").collect()),
    ).toEqual([
      expect.objectContaining({ targetPersonId: fixture.reservePersonId }),
    ]);
  });

  test("sends one shift reminder and cancels it when confirmed hours change", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await prepareReviewerClockIn(backend, fixture);
    const shiftStartsAt = Date.now() + 240_000;
    const confirmationId = await backend.run(async (ctx) => {
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!confirmation) throw new Error("Confirmation fixture missing");
      await ctx.db.patch(confirmation._id, {
        windows: [
          { startsAt: shiftStartsAt, endsAt: shiftStartsAt + 1_200_000 },
        ],
      });
      return confirmation._id;
    });
    const args = { confirmationId, confirmationVersion: 1, shiftStartsAt };
    await backend.mutation(
      internal.reviewConfirmations.prepareShiftReminder,
      args,
    );
    await backend.mutation(
      internal.reviewConfirmations.prepareShiftReminder,
      args,
    );
    const notifications = await backend.run((ctx) =>
      ctx.db.query("reviewConfirmationNotifications").collect(),
    );
    expect(notifications).toHaveLength(1);
    const notification = notifications[0];
    if (!notification) throw new Error("Notification fixture missing");
    expect(notification.purpose).toBe("shift_reminder");
    await backend.run((ctx) =>
      ctx.db.patch(confirmationId, {
        status: "unavailable",
        windows: [],
        version: 2,
      }),
    );
    expect(
      await backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId: notification._id,
        attemptId: "stale-shift",
      }),
    ).toBeNull();
    expect(
      await backend.run((ctx) => ctx.db.get(notification._id)),
    ).toMatchObject({
      state: "cancelled",
    });
  });

  test("replaces an on-duty reviewer who never scans in before the review arrival deadline", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await prepareAutomaticStaffing(backend, fixture);
    const sessionId = await seedLiveReview(backend, fixture);
    const missingScorecardId = await backend.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(sessionId, {
        status: "awaiting_presence",
        createdAt: now - 120_000,
      });
      await ctx.db.patch(fixture.memberId, { assignedAt: now - 120_000 });
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .collect();
      let missing: Id<"scorecards"> | undefined;
      for (const member of members) {
        const assignmentId = await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId: sessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: now - 120_000,
        });
        const scorecardId = await ctx.db.insert("scorecards", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          reviewSessionId: sessionId,
          reviewerPersonId: member.personId,
          assignmentId,
          rubricVersionId: fixture.rubricVersionId,
          status: "draft",
          ratings: [],
          draftVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        if (member.personId === fixture.memberPersonId) missing = scorecardId;
        else
          await ctx.db.insert("reviewPresence", {
            eventId: fixture.eventId,
            reviewSessionId: sessionId,
            reviewerPersonId: member.personId,
            method: "qr",
            tokenVersion: 1,
            confirmedAt: now,
          });
      }
      return missing;
    });
    if (!missingScorecardId) throw new Error("Scorecard fixture missing");
    await backend.mutation(internal.reviewStaffing.checkPanel, {
      panelId: fixture.panelId,
    });
    expect(
      await backend.run((ctx) => ctx.db.get(fixture.memberId)),
    ).toMatchObject({
      status: "removed",
    });
    expect(
      await backend.run((ctx) => ctx.db.get(missingScorecardId)),
    ).toMatchObject({
      status: "void",
    });
    expect(await backend.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "awaiting_presence",
    });
    expect(
      await backend.run((ctx) => ctx.db.query("reviewerPages").collect()),
    ).toEqual([
      expect.objectContaining({
        targetPersonId: fixture.reservePersonId,
        reviewSessionId: sessionId,
      }),
    ]);
  });

  test("ends the discussion at its deadline without closing score entry or letting a stale timer end an extension", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const sessionId = await seedLiveReview(backend, fixture);
    const deadline = Date.now() - 1;
    await backend.run((ctx) =>
      ctx.db.patch(sessionId, { plannedEndAt: deadline }),
    );
    await backend.mutation(
      internal.reviewOperations.finishDiscussionAtDeadline,
      {
        reviewSessionId: sessionId,
        expectedPlannedEndAt: deadline - 60_000,
      },
    );
    expect(await backend.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "active",
      version: 1,
    });
    await backend.mutation(
      internal.reviewOperations.finishDiscussionAtDeadline,
      {
        reviewSessionId: sessionId,
        expectedPlannedEndAt: deadline,
      },
    );
    await backend.mutation(
      internal.reviewOperations.finishDiscussionAtDeadline,
      {
        reviewSessionId: sessionId,
        expectedPlannedEndAt: deadline,
      },
    );
    expect(await backend.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "scoring",
      version: 2,
    });
  });
});

describe("reviewer commitments across rounds", () => {
  test.each(["overlap", "touching_before", "touching_after", "closed"] as const)(
    "publication checks occupied review hours (%s)",
    async (timing) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      await preparePublicationPolicy(backend, fixture);
      const round = await backend.run((ctx) => ctx.db.get(fixture.roundId));
      if (!round) throw new Error("Round fixture missing");
      if (timing === "closed") {
        await backend.run((ctx) => ctx.db.patch(round._id, { status: "closed" }));
      }
      const startsAt = timing === "touching_before"
        ? round.startsAt - 3_600_000
        : timing === "touching_after"
          ? round.endsAt
          : round.endsAt - 1;
      const request = publicationRequest(fixture, startsAt, fixture.memberPersonId);
      const publish = asOperator(backend, fixture).mutation(
        api.reviewConfiguration.publishRound,
        request,
      );
      if (timing === "overlap") {
        await expect(publish).rejects.toThrow("already has a panel assignment during these review hours");
        await backend.run(async (ctx) => {
          expect(await ctx.db.query("reviewRounds").collect()).toHaveLength(1);
          expect(await ctx.db.query("reviewPanels").collect()).toHaveLength(1);
          expect(await ctx.db.query("reviewRubricVersions").collect()).toHaveLength(1);
          expect(await ctx.db.get(fixture.memberId)).toMatchObject({ status: "active" });
        });
      } else {
        const published = await publish;
        expect(published.roundId).not.toBe(fixture.roundId);
      }
    },
  );

  test("overlapping rounds can share their reserve pool", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await preparePublicationPolicy(backend, fixture);
    const round = await backend.run((ctx) => ctx.db.get(fixture.roundId));
    if (!round) throw new Error("Round fixture missing");
    // Free one reviewer to lead the new panel; the reserve stays in both pools.
    await asOperator(backend, fixture).mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      expectedPanelVersion: 1,
      reason: "Move this reviewer to the new panel.",
      clientOperationId: "free-new-panel-lead",
    });
    const request = publicationRequest(fixture, round.startsAt, fixture.memberPersonId);
    request.reservePersonIds = [fixture.reservePersonId];
    const published = await asOperator(backend, fixture).mutation(
      api.reviewConfiguration.publishRound,
      request,
    );
    const reserves = await backend.run((ctx) => ctx.db.query("reviewRoundReserves").collect());
    expect(reserves.filter((reserve) => reserve.personId === fixture.reservePersonId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ roundId: fixture.roundId, status: "available" }),
        expect.objectContaining({ roundId: published.roundId, status: "available" }),
      ]));
  });

  test.each(["published", "open"] as const)(
    "automatic paging skips a reviewer seated in an overlapping %s round between reviews",
    async (status) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      await prepareAutomaticStaffing(backend, fixture);
      await preparePublicationPolicy(backend, fixture);
      const published = await asOperator(backend, fixture).mutation(
        api.reviewConfiguration.publishRound,
        publicationRequest(fixture, Date.now(), fixture.reservePersonId),
      );
      await backend.run((ctx) => ctx.db.patch(published.roundId, { status }));
      await clockOutStaffingMember(backend, fixture);

      await backend.mutation(internal.reviewStaffing.checkPanel, { panelId: fixture.panelId });

      await backend.run(async (ctx) => {
        expect(await ctx.db.query("reviewerPages").collect()).toHaveLength(0);
        expect(await ctx.db.get(fixture.panelId)).toMatchObject({ status: "needs_reviewer" });
        expect(await ctx.db.get(fixture.reserveId)).toMatchObject({ status: "available" });
      });
    },
  );

  test.each(["published", "closed"] as const)(
    "manual swaps respect an existing %s round's commitment",
    async (status) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      await preparePublicationPolicy(backend, fixture);
      const operator = asOperator(backend, fixture);
      const published = await operator.mutation(
        api.reviewConfiguration.publishRound,
        publicationRequest(fixture, Date.now(), fixture.reservePersonId),
      );
      await backend.run((ctx) => ctx.db.patch(published.roundId, { status }));
      const swap = operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.memberPersonId,
        joiningPersonId: fixture.reservePersonId,
        expectedPanelVersion: 1,
        reason: "Replace the reviewer who is leaving.",
        clientOperationId: "swap-with-existing-commitment",
      });
      if (status === "published") {
        await expect(swap).rejects.toThrow("already sits on a panel whose round overlaps");
        await backend.run(async (ctx) => {
          expect(await ctx.db.get(fixture.memberId)).toMatchObject({ status: "active" });
          expect(await ctx.db.get(fixture.panelId)).toMatchObject({ status: "ready", version: 1 });
          expect(await ctx.db.get(fixture.reserveId)).toMatchObject({ status: "available" });
        });
      } else {
        await expect(swap).resolves.toMatchObject({ status: "ready", version: 2 });
      }
    },
  );

  test.each(["overlap", "touching_after"] as const)(
    "page acceptance rechecks a commitment added after paging (%s)",
    async (timing) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      await prepareAutomaticStaffing(backend, fixture);
      await preparePublicationPolicy(backend, fixture);
      await clockOutStaffingMember(backend, fixture);
      await backend.mutation(internal.reviewStaffing.checkPanel, { panelId: fixture.panelId });
      const pages = await backend.run((ctx) => ctx.db.query("reviewerPages").collect());
      expect(pages).toHaveLength(1);
      const page = pages[0];
      if (!page) throw new Error("Expected a reserve page");
      expect(page.targetPersonId).toBe(fixture.reservePersonId);
      const round = await backend.run((ctx) => ctx.db.get(fixture.roundId));
      if (!round) throw new Error("Round fixture missing");
      await asOperator(backend, fixture).mutation(
        api.reviewConfiguration.publishRound,
        publicationRequest(
          fixture,
          timing === "overlap" ? round.startsAt : round.endsAt,
          fixture.reservePersonId,
        ),
      );
      const now = Date.now();
      const authUserId = await createAuthUser(backend, now);
      const authSessionId = await createAuthSession(backend, authUserId, now);
      const installationId = await backend.run(async (ctx) => {
        await ctx.db.patch(fixture.reservePersonId, { authUserId });
        const clock = await ctx.db.query("reviewerClockIns")
          .withIndex("by_round_person", (q) =>
            q.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.reservePersonId),
          ).unique();
        if (!clock) throw new Error("Reserve clock fixture missing");
        const device = await ctx.db.get(clock.reviewerDeviceId);
        if (!device) throw new Error("Reserve device fixture missing");
        return device.installationId;
      });
      const response = backend.withIdentity({ subject: authUserId, sessionId: authSessionId })
        .mutation(api.reviewSubstitutions.respondToPage, {
          eventSlug: fixture.eventSlug,
          pageId: page._id,
          response: "accept",
          installationId,
          expectedVersion: page.version,
          clientOperationId: "accept-after-publication",
        });
      if (timing === "overlap") {
        await expect(response).rejects.toThrow("RESERVE_NO_LONGER_ELIGIBLE");
        expect(await backend.run((ctx) => ctx.db.get(page._id)))
          .toMatchObject({ state: page.state, version: page.version });
      } else {
        await expect(response).resolves.toMatchObject({ state: "accepted" });
      }
      const seats = await backend.run((ctx) => ctx.db.query("reviewPanelMembers")
        .withIndex("by_event_person_status", (q) =>
          q.eq("eventId", fixture.eventId).eq("personId", fixture.reservePersonId).eq("status", "active"),
        ).collect());
      expect(seats).toHaveLength(timing === "overlap" ? 1 : 2);
    },
  );
});

async function clockOutStaffingMember(backend: BackendTest, fixture: Fixture) {
  await backend.run(async (ctx) => {
    const clock = await ctx.db.query("reviewerClockIns")
      .withIndex("by_round_person", (q) =>
        q.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.memberPersonId),
      ).unique();
    if (!clock) throw new Error("Member clock fixture missing");
    await ctx.db.patch(clock._id, { status: "clocked_out" });
  });
}

async function prepareAutomaticStaffing(
  backend: BackendTest,
  fixture: Fixture,
) {
  await backend.run(async (ctx) => {
    const now = Date.now();
    const round = await ctx.db.get(fixture.roundId);
    if (!round) throw new Error("Round fixture missing");
    await ctx.db.patch(round._id, {
      staffing: { ...round.staffing, automaticReplacement: true },
    });
    for (const permissionKey of [
      "review.substitute.page",
      "review.substitute.assign",
    ] as const)
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey,
        scopeType: "panel",
        scopeId: fixture.panelId,
        sourceType: "manual",
        sourceId: `auto-${permissionKey}`,
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Automatic staffing test",
      });
    for (const personId of [
      fixture.coordinatorPersonId,
      fixture.memberPersonId,
      fixture.secondMemberPersonId,
      fixture.reservePersonId,
    ]) {
      const reviewerDeviceId = await ctx.db.insert("reviewerDevices", {
        eventId: fixture.eventId,
        personId,
        installationId: crypto.randomUUID(),
        name: "Staffing fixture phone",
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
      await ctx.db.insert("reviewerClockIns", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        reviewerPersonId: personId,
        reviewerDeviceId,
        status: "present",
        clockedInAt: now,
        lastHeartbeatAt: now,
        version: 1,
      });
    }
  });
}

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
    },
    );
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
    },
    );
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
    },
    );
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2,
    });

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId),
        )
        .collect();
      const leaving = members.find((member) => member.personId === fixture.memberPersonId,
      );
      const joining = members.find((member) => member.personId === fixture.reservePersonId,
      );
      expect(leaving?.status).toBe("replaced");
      expect(joining?.status).toBe("active");
      expect(joining?.isCoordinator).toBe(false);
      expect(joining?.assignedCriterionIds).toEqual(leaving?.assignedCriterionIds,
      );
      expect(members.filter((member) => member.status === "active"),
      ).toHaveLength(3);

      const panel = await ctx.db.get(fixture.panelId);
      expect(panel?.coordinatorPersonId).toBe(fixture.coordinatorPersonId);

      const reserve = await ctx.db.get(fixture.reserveId);
      expect(reserve?.status).toBe("assigned");

      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId),
        )
        .collect();
      expect(
        audit.filter((entry) => entry.action === "review.panel_membership_changed",
        ),
      ).toHaveLength(1);
    });

    expect(
      await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", fixture.memberId,
      ),
    ).toBe(0);
    expect(
      await activeSourceGrantCount(
        backend,
        fixture.eventId,
        "reserve_assignment",
        fixture.reserveId,
      ),
    ).toBe(0);
    const joiningMemberId = await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .collect();
      const joining = members.find((member) => member.personId === fixture.reservePersonId,
      );
      if (!joining) throw new Error("The joining panel member is missing.");
      return joining._id;
    });
    expect(
      await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", joiningMemberId,
      ),
    ).toBe(5);
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
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId),
        )
        .collect();
      expect(members.filter((member) => member.status === "active"),
      ).toHaveLength(3);
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
    const first = await operator.mutation(api.reviewPanelMembership.swapPanelMember, request,
    );
    expect(await operator.mutation(api.reviewPanelMembership.swapPanelMember, request,
      ),
    ).toEqual(first);

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId),
        )
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
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId),
        )
        .collect();
      expect(
        audit.filter((entry) => entry.action === "review.panel_membership_changed",
        ),
      ).toHaveLength(1);
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
    },
    );
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2,
    });
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

  test("lets any assigned reviewer complete only after every scorecard is submitted", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const reviewSessionId = await seedLiveReview(backend, fixture);
    const seeded = await backend.run(async (ctx) => {
      const now = Date.now();
      const [session, round, panelMembers, criteria] = await Promise.all([
        ctx.db.get(reviewSessionId),
        ctx.db.get(fixture.roundId),
        ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", fixture.panelId).eq("status", "active"),
          )
          .collect(),
        ctx.db
          .query("reviewRubricCriteria")
          .withIndex("by_rubric_order", (index) =>
            index.eq("rubricVersionId", fixture.rubricVersionId),
          )
          .collect(),
      ]);
      if (!session || !round) throw new Error("The completion test review is missing.");
      await ctx.db.patch(round._id, { requiresSharedCommitments: false, requiresFinalComment: true });
      await insertTeamRoundState(ctx, {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        teamId: session.teamId,
        panelId: fixture.panelId,
        state: "in_review",
        queuedAt: now - 60_000,
        calledAt: now - 30_000,
        callAttemptCount: 1,
        lastCallAttemptAt: now - 30_000,
        priority: 0,
        version: 1,
        updatedByPersonId: fixture.operatorPersonId,
        updatedAt: now,
      });

      let pendingScorecardId: Id<"scorecards"> | null = null;
      for (const [index, member] of panelMembers.entries()) {
        const assignmentId = await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: now,
        });
        const isPending = index === panelMembers.length - 1;
        const ratings = criteria.map((criterion) => ({ criterionId: criterion._id, score: 2 }));
        const scorecardId = await ctx.db.insert("scorecards", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          reviewSessionId,
          reviewerPersonId: member.personId,
          assignmentId,
          rubricVersionId: fixture.rubricVersionId,
          status: isPending ? "draft" : "submitted",
          ratings,
          finalComment: "Reviewed the delivered prototype and discussed architecture improvements.",
          draftVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...(isPending ? {} : { submittedAt: now }),
        });
        if (isPending) {
          pendingScorecardId = scorecardId;
        } else {
          const submittedVersionId = await ctx.db.insert("scorecardVersions", {
            eventId: fixture.eventId,
            roundId: fixture.roundId,
            reviewSessionId,
            scorecardId,
            reviewerPersonId: member.personId,
            version: 1,
            rubricVersionId: fixture.rubricVersionId,
            ratings,
          finalComment: "Reviewed the delivered prototype and discussed architecture improvements.",
            checksum: `submitted-${scorecardId}`,
            clientOperationId: `submit-${scorecardId}`,
            submittedAt: now,
          });
          await ctx.db.patch(scorecardId, { submittedVersionId });
        }
        await grantReviewAssignmentAccess(ctx, {
          eventId: fixture.eventId,
          reviewSessionId,
          scorecardId,
          assignmentId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          grantedByPersonId: fixture.operatorPersonId,
          isCoordinator: member.isCoordinator,
        });
      }
      const removedAssignmentId = await ctx.db.insert("reviewAssignments", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        reviewSessionId,
        reviewerPersonId: fixture.reservePersonId,
        eventAccessSubjectId: fixture.reserveSubjectId,
        assignedCriterionIds: criteria.map((criterion) => criterion._id),
        isCoordinator: false,
        status: "removed",
        assignedAt: now - 120_000,
        endedAt: now - 90_000,
      });
      await ctx.db.insert("scorecards", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        reviewSessionId,
        reviewerPersonId: fixture.reservePersonId,
        assignmentId: removedAssignmentId,
        rubricVersionId: fixture.rubricVersionId,
        status: "void",
        ratings: [],
        draftVersion: 0,
        version: 2,
        createdAt: now - 120_000,
        updatedAt: now - 90_000,
      });
      if (!pendingScorecardId) throw new Error("The pending scorecard was not created.");
      return { pendingScorecardId, expectedVersion: session.version };
    });

    const beforeEverySubmission = await reviewer.identity.query(api.reviewer.now, {
      eventSlug: fixture.eventSlug,
      installationId: reviewer.installationId,
    });
    expect(beforeEverySubmission.review?.assignment).toMatchObject({
      reviewerCount: 3,
      submittedScorecardCount: 2,
      completionReady: false,
    });

    await expect(
      reviewer.identity.mutation(api.reviewOperations.completeReview, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
        expectedVersion: seeded.expectedVersion,
        reason: "Panel finished scoring",
        clientOperationId: "complete-before-all-scorecards",
      }),
    ).rejects.toThrow("Every assigned reviewer must submit a valid scorecard first");

    await backend.run(async (ctx) => {
      const scorecard = await ctx.db.get(seeded.pendingScorecardId);
      if (!scorecard) throw new Error("The pending scorecard is missing.");
      const submittedAt = Date.now();
      const submittedVersionId = await ctx.db.insert("scorecardVersions", {
        eventId: scorecard.eventId,
        roundId: scorecard.roundId,
        reviewSessionId,
        scorecardId: scorecard._id,
        reviewerPersonId: scorecard.reviewerPersonId,
        version: 1,
        rubricVersionId: scorecard.rubricVersionId,
        ratings: scorecard.ratings,
        finalComment: "Reviewed the delivered prototype and discussed architecture improvements.",
        checksum: `submitted-${scorecard._id}`,
        clientOperationId: `submit-${scorecard._id}`,
        submittedAt,
      });
      await ctx.db.patch(scorecard._id, {
        status: "submitted",
        submittedVersionId,
        submittedAt,
        updatedAt: submittedAt,
      });
    });

    const afterEverySubmission = await reviewer.identity.query(api.reviewer.now, {
      eventSlug: fixture.eventSlug,
      installationId: reviewer.installationId,
    });
    expect(afterEverySubmission.review?.assignment).toMatchObject({
      reviewerCount: 3,
      submittedScorecardCount: 3,
      completionReady: true,
    });

    const result = await reviewer.identity.mutation(api.reviewOperations.completeReview, {
      eventSlug: fixture.eventSlug,
      reviewSessionId,
      expectedVersion: seeded.expectedVersion,
      reason: "Panel finished scoring",
      clientOperationId: "complete-after-all-scorecards",
    });
    expect(result.reviewSessionId).toBe(reviewSessionId);
    await backend.run(async (ctx) => {
      const session = await ctx.db.get(reviewSessionId);
      if (!session) throw new Error("The completed review session is missing.");
      const [state, evaluation] = await Promise.all([
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_team", (index) =>
            index.eq("roundId", fixture.roundId).eq("teamId", session.teamId),
          )
          .unique(),
        ctx.db
          .query("reviewEvaluations")
          .withIndex("by_session", (index) => index.eq("reviewSessionId", reviewSessionId))
          .unique(),
      ]);
      expect(session.status).toBe("completed");
      expect(state?.state).toBe("completed");
      expect(evaluation?.state).toBe("complete");
      expect(evaluation?.criterionResults.every((criterion) => criterion.scoreCount === 3)).toBe(
        true,
      );
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
        staffing: {
          seniorSeats: 0,
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
        requiresSharedCommitments: false,
        requiresFinalComment: false,
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
        seatSeniority: "lead",
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
      operator.query(api.reviewSubstitutions.currentPage, { eventSlug: fixture.eventSlug,
      }),
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
      const panelReadGrant = grants.find((grant) => grant.permissionKey === "panel.read",
      );
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
      },
      ),
    ).rejects.toThrow(`at most ${maximumReviewTeamsPerEvent} teams`);
  });

  test("clock-in opens at the exact published boundary and a rejected attempt writes nothing", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await setReviewerTiming(backend, fixture.roundId, boundary);
    const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId,
    );
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
      ).rejects.toThrow("Clock-in is available only from the published opening",
      );
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId),
      ).toEqual(before);

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

  test("clock-in rejects a reviewer outside confirmed availability without writes", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const boundary = Date.now() + 5 * 60_000;
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await setReviewerTiming(backend, fixture.roundId, boundary);
    await backend.run(async (ctx) => {
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (index) =>
          index.eq("roundId", fixture.roundId).eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!confirmation) throw new Error("The reviewer profile is missing.");
      await ctx.db.patch(confirmation._id, {
        windows: [{ startsAt: boundary - 3_600_000, endsAt: boundary - 60_001 },
        ],
        version: confirmation.version + 1,
      });
    });
    const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId,
    );
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
      ).rejects.toThrow("Confirm your availability in the app");
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId),
      ).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  test("a reviewer can clock out once with an idempotent audited command", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);

    await reviewer.identity.mutation(api.reviewer.clockIn, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      expectedVersion: 0,
      clientOperationId: "clock-in-before-clock-out",
    });
    const request = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      expectedVersion: 1,
      clientOperationId: "reviewer-clock-out",
      status: "clocked_out" as const,
      reason: "Finished reviewing for this round",
    };
    const first = await reviewer.identity.mutation(api.reviewer.setAvailability, request);
    const retry = await reviewer.identity.mutation(api.reviewer.setAvailability, request);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({ status: "clocked_out", version: 2 });
    await backend.run(async (ctx) => {
      const [clockIn, operations, audits] = await Promise.all([
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (index) =>
            index.eq("roundId", fixture.roundId).eq("reviewerPersonId", fixture.memberPersonId),
          )
          .unique(),
        ctx.db
          .query("operationResults")
          .collect()
          .then((rows) => rows.filter((row) => row.commandName === "reviewer.availability.set")),
        ctx.db
          .query("auditEvents")
          .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
          .collect()
          .then((rows) => rows.filter((row) => row.action === "reviewer.availability_changed")),
      ]);
      expect(clockIn).toMatchObject({
        status: "clocked_out",
        version: 2,
        clockedOutAt: expect.any(Number),
      });
      expect(operations).toHaveLength(1);
      expect(audits).toHaveLength(1);
    });

    const returnRequest = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      expectedVersion: 2,
      clientOperationId: "clock-in-after-clock-out",
    };
    await backend.run((ctx) => ctx.db.patch(fixture.roundId, { minimumReviewerBuild: 2 }));
    await expect(reviewer.identity.mutation(api.reviewer.clockIn, returnRequest))
      .rejects.toThrow("Update the app and complete the required camera and notification checks");
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(first.clockInId)).toMatchObject({ status: "clocked_out", version: 2 });
      const device = await ctx.db.query("reviewerDevices")
        .withIndex("by_event_installation", (index) => index.eq("eventId", fixture.eventId).eq("installationId", reviewer.installationId))
        .unique();
      if (!device) throw new Error("The reviewer's phone is missing.");
      await ctx.db.patch(device._id, { appBuild: 2 });
    });
    const returned = await reviewer.identity.mutation(api.reviewer.clockIn, returnRequest);
    expect(returned).toMatchObject({ clockInId: first.clockInId, version: 3 });
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(first.clockInId)).toMatchObject({ status: "present", version: 3 });
    });
  });

  test("clock-out is rejected while the reviewer has a live review", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await reviewer.identity.mutation(api.reviewer.clockIn, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      expectedVersion: 0,
      clientOperationId: "clock-in-before-active-review",
    });
    const reviewSessionId = await seedLiveReview(backend, fixture);
    await backend.run(async (ctx) => {
      const member = await ctx.db.get(fixture.memberId);
      if (!member) throw new Error("The reviewer panel member is missing.");
      await ctx.db.insert("reviewAssignments", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        reviewSessionId,
        reviewerPersonId: fixture.memberPersonId,
        eventAccessSubjectId: member.eventAccessSubjectId,
        assignedCriterionIds: member.assignedCriterionIds,
        isCoordinator: member.isCoordinator,
        status: "assigned",
        assignedAt: Date.now(),
      });
    });

    await expect(
      reviewer.identity.mutation(api.reviewer.setAvailability, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 1,
        clientOperationId: "clock-out-with-active-review",
        status: "clocked_out",
        reason: "Finished reviewing for this round",
      }),
    ).rejects.toThrow("Finish the current review and its scorecards before leaving");

    const snapshot = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId);
    expect(snapshot.clockIns).toEqual([
      expect.objectContaining({ status: "present", version: 1 }),
    ]);
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
      expect(await reviewerPolicySnapshot(backend, fixture, null)).toEqual(before,
      );

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
      const before = await reviewerPolicySnapshot(backend, fixture, reviewer.installationId,
      );

      clock.mockReturnValue(boundary);
      await expect(
        asOperator(backend, fixture).mutation(api.reviewSubstitutions.markNoShow, {
          eventSlug: fixture.eventSlug,
          panelMemberId: fixture.memberId,
          expectedPanelVersion: 1,
          expectedClockInVersion: 1,
          reason: "Desk believed the reviewer was absent.",
          clientOperationId: "present-reviewer-no-show",
        },
        ),
      ).rejects.toThrow("A reviewer who is present cannot be marked as a no-show",
      );
      expect(await reviewerPolicySnapshot(backend, fixture, reviewer.installationId),
      ).toEqual(before);
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
        },
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
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

  test("round publication creates pending confirmations without assuming form hours", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const startsAt = Date.now() + 60 * 60_000;
    await preparePublicationPolicy(backend, fixture);
    await expect(
      asOperator(backend, fixture).mutation(
        api.reviewConfiguration.publishRound,
        publicationRequest(fixture, startsAt, fixture.memberPersonId),
      ),
    ).resolves.toMatchObject({ roundId: expect.any(String) });
    await backend.run(async (ctx) => {
      const round = await ctx.db
        .query("reviewRounds")
        .withIndex("by_event_key", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("stableKey", "availability_fixture_round"),
        )
        .unique();
      if (!round) throw new Error("Round missing.");
      const response = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q.eq("roundId", round._id).eq("personId", fixture.memberPersonId),
        )
        .unique();
      expect(response).toMatchObject({ status: "pending", windows: [] });
    });
  });
});

describe("round availability confirmation", () => {
  test("ops can reschedule before opening without duplicate notifications or stale writes", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const now = Date.now();
    await preparePublicationPolicy(backend, fixture);
    await setReviewerTiming(backend, fixture.roundId, now + 3_600_000);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const requestId = await backend.run(async (ctx) => {
      const request = await ctx.db
        .query("reviewConfirmationRequests")
        .withIndex("by_roundId", (q) => q.eq("roundId", fixture.roundId))
        .unique();
      if (!request) throw new Error("Confirmation request missing.");
      await ctx.db.patch(request._id, {
        state: "scheduled",
        opensAt: now + 300_000,
      });
      const confirmations = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q.eq("roundId", fixture.roundId),
        )
        .collect();
      for (const response of confirmations) {
        await ctx.db.patch(response._id, { status: "pending", windows: [] });
      }
      return request._id;
    });
    const args = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      opensAt: now + 600_000,
      expectedVersion: 1,
      reason: "Allow more time for app setup.",
      clientOperationId: "reschedule-confirmation",
    };
    await expect(
      reviewer.identity.mutation(api.reviewConfirmations.reschedule, args),
    ).rejects.toThrow();
    const operator = asOperator(backend, fixture);
    await expect(
      operator.mutation(api.reviewConfirmations.reschedule, args),
    ).resolves.toEqual({
      version: 2,
    });
    await expect(
      operator.mutation(api.reviewConfirmations.reschedule, args),
    ).resolves.toEqual({
      version: 2,
    });
    await expect(
      operator.mutation(api.reviewConfirmations.reschedule, {
        ...args,
        clientOperationId: "stale-reschedule",
        opensAt: now + 900_000,
      }),
    ).rejects.toThrow("schedule changed");

    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + 300_000);
      await backend.mutation(internal.reviewConfirmations.openRequest, {
        requestId,
      });
      expect(await backend.run((ctx) => ctx.db.get(requestId))).toMatchObject({
        state: "scheduled",
        version: 2,
      });
      expect(
        await backend.run((ctx) =>
          ctx.db.query("reviewConfirmationNotifications").collect(),
        ),
      ).toHaveLength(0);
      clock.mockReturnValue(now + 600_000);
      await backend.mutation(internal.reviewConfirmations.openRequest, {
        requestId,
      });
      await backend.mutation(internal.reviewConfirmations.openRequest, {
        requestId,
      });
      expect(await backend.run((ctx) => ctx.db.get(requestId))).toMatchObject({
        state: "open",
        version: 3,
      });
      expect(
        await backend.run((ctx) =>
          ctx.db.query("reviewConfirmationNotifications").collect(),
        ),
      ).toHaveLength(4);
      await expect(
        operator.mutation(api.reviewConfirmations.reschedule, {
          ...args,
          expectedVersion: 3,
          clientOperationId: "opened-reschedule",
          opensAt: now + 900_000,
        }),
      ).rejects.toThrow("cannot change after reviewers can respond");
    } finally {
      clock.mockRestore();
    }
    const audits = await backend.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (q) => q.eq("eventId", fixture.eventId))
        .collect(),
    );
    expect(
      audits.filter(
        (entry) => entry.action === "review.confirmation_rescheduled",
      ),
    ).toHaveLength(1);
  });

  test("survey import keeps reviewer evidence, binds the preview, and does not infer hours", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await backend.run(async (ctx) => {
      for (const permissionKey of [
        "access.roster.import",
        "reviewer.profile.manage",
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.operatorPersonId,
          eventAccessSubjectId: fixture.operatorSubjectId,
          permissionKey,
          scopeType: "event",
          sourceType: "manual",
          sourceId: `pool:${permissionKey}`,
          grantedByPersonId: fixture.operatorPersonId,
          reason: "Import reviewer pool fixture",
        });
      }
    });
    const operator = asOperator(backend, fixture);
    const args = {
      eventSlug: fixture.eventSlug,
      sourceName: "Reviewer form",
      sourceFileName: "reviewers.tsv",
      validFrom: Date.now() - 1_000,
      validUntil: Date.now() + 600_000,
      bundleVersionIds: [],
      reason: "Import all reviewers for round confirmation",
      rows: [
        {
          rowNumber: 2,
          email: "reviewer@vitstudent.ac.in",
          displayName: "New Reviewer",
          role: "sc" as const,
          reviewerDetails: {
            domain: "Research",
            skills: "Cloud\nArchitecture",
            resumeUrl: "https://drive.google.com/fixture",
            githubReference: "reviewer",
          },
        },
      ],
    };
    const preview = await operator.query(api.rosters.previewImport, args);
    await expect(
      operator.mutation(api.rosters.confirmImport, {
        ...args,
        rows: [
          {
            ...args.rows[0]!,
            reviewerDetails: {
              ...args.rows[0]!.reviewerDetails,
              skills: "Changed",
            },
          },
        ],
        previewChecksum: preview.previewChecksum,
        clientOperationId: "pool-tampered-preview",
      }),
    ).rejects.toThrow("changed");
    const confirm = {
      ...args,
      previewChecksum: preview.previewChecksum,
      clientOperationId: "pool-import-confirmed",
    };
    await operator.mutation(api.rosters.confirmImport, confirm);
    await operator.mutation(api.rosters.confirmImport, confirm);
    await backend.run(async (ctx) => {
      const pool = await ctx.db
        .query("reviewerPoolEntries")
        .withIndex("by_eventId_and_emailNormalized", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("emailNormalized", "reviewer@vitstudent.ac.in"),
        )
        .unique();
      expect(pool).toMatchObject({
        seniority: "sc",
        skills: "Cloud\nArchitecture",
        resumeUrl: "https://drive.google.com/fixture",
      });
      expect(pool).not.toHaveProperty("availabilityWindows");
    });
  });

  test("accepts more than three slots, keeps other people independent, and retries idempotently", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const round = await backend.run((ctx) => ctx.db.get(fixture.roundId));
    if (!round) throw new Error("Round missing.");
    const windows = Array.from({ length: 4 }, (_, index) => ({
      startsAt: round.startsAt + index * 15 * 60_000,
      endsAt: round.startsAt + (index + 1) * 15 * 60_000,
    }));
    const args = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      windows,
      expectedVersion: 1,
      clientOperationId: "confirm-four-hours",
    };
    expect(
      await reviewer.identity.mutation(api.reviewConfirmations.respond, args),
    ).toEqual({
      version: 2,
    });
    expect(
      await reviewer.identity.mutation(api.reviewConfirmations.respond, args),
    ).toEqual({
      version: 2,
    });
    const mine = await reviewer.identity.query(api.reviewConfirmations.mine, {
      eventSlug: fixture.eventSlug,
    });
    expect(mine[0]?.response).toMatchObject({
      status: "confirmed",
      version: 2,
      windows: [
        { startsAt: round.startsAt, endsAt: round.startsAt + 60 * 60_000 },
      ],
    });
    await expect(
      reviewer.identity.mutation(api.reviewConfirmations.respond, {
        ...args,
        windows: [],
        clientOperationId: "stale-confirmation",
      }),
    ).rejects.toThrow("availability changed");
    await backend.run(async (ctx) => {
      const other = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("personId", fixture.reservePersonId),
        )
        .unique();
      expect(other?.version).toBe(1);
    });
  });

  test("unavailable and pending reviewers cannot clock in", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    await reviewer.identity.mutation(api.reviewConfirmations.respond, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      windows: [],
      expectedVersion: 1,
      clientOperationId: "decline-round",
    });
    await expect(
      reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 0,
        clientOperationId: "declined-clock-in",
      }),
    ).rejects.toThrow("Confirm your availability");
    await backend.run(async (ctx) => {
      const response = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!response) throw new Error("Confirmation missing.");
      await ctx.db.patch(response._id, { status: "pending" });
    });
    await expect(
      reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 0,
        clientOperationId: "pending-clock-in",
      }),
    ).rejects.toThrow("Confirm your availability");
  });

  test.each(["active", "scoring"] as const)(
    "a reviewer cannot end their shift during %s",
    async (status) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      const reviewer = await prepareReviewerClockIn(backend, fixture);
      const clockIn = await reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 0,
        clientOperationId: "shift-clock-in",
      });
      const sessionId = await seedLiveReview(backend, fixture);
      await backend.run(async (ctx) => {
        await ctx.db.patch(sessionId, { status });
        const member = await ctx.db.get(fixture.memberId);
        if (!member) throw new Error("Missing member");
        await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId: sessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: Date.now(),
        });
      });
      const command = {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        status: "clocked_out" as const,
        reason: "Finishing my shift",
        expectedVersion: clockIn.version,
        clientOperationId: "shift-clock-out",
      };
      await expect(
        reviewer.identity.mutation(api.reviewer.setAvailability, command),
      ).rejects.toThrow("Finish the current review");
      await backend.run((ctx) =>
        ctx.db.patch(sessionId, {
          status: "completed",
          completedAt: Date.now(),
        }),
      );
      const result = await reviewer.identity.mutation(
        api.reviewer.setAvailability,
        command,
      );
      expect(result.status).toBe("clocked_out");
      expect(
        await reviewer.identity.mutation(api.reviewer.setAvailability, command),
      ).toEqual(result);
    },
  );

  test.each(["active", "scoring"] as const)(
    "venue departure respects the %s review lock, then clocks out exactly once",
    async (status) => {
      const backend = seededBackend();
      const fixture = await seedPanel(backend);
      const reviewer = await prepareReviewerClockIn(backend, fixture);
      const clockIn = await reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: 0,
        clientOperationId: "venue-clock-in",
      });
      const sessionId = await seedLiveReview(backend, fixture);
      await backend.run(async (ctx) => {
        await ctx.db.patch(fixture.eventId, { status: "live" });
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.memberPersonId,
          eventAccessSubjectId: fixture.memberSubjectId,
          permissionKey: "reviewer.device.register",
          scopeType: "self",
          scopeId: fixture.memberSubjectId,
          sourceType: "manual",
          sourceId: "venue-test",
          grantedByPersonId: fixture.operatorPersonId,
          reason: "Venue lifecycle test",
        });
        await ctx.db.insert("reviewerVenuePolicies", {
          eventId: fixture.eventId,
          enabled: true,
          name: "Hall",
          latitude: 12,
          longitude: 79,
          radiusMeters: 200,
          startsAt: Date.now() - 60000,
          endsAt: Date.now() + 86400000,
          absenceGraceMinutes: 5,
          callDelayMinutes: 10,
          version: 1,
          updatedByPersonId: fixture.operatorPersonId,
          updatedAt: Date.now(),
        });
        await ctx.db.patch(sessionId, { status });
        const member = await ctx.db.get(fixture.memberId);
        if (!member) throw new Error("Missing member");
        await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId: sessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: Date.now(),
        });
      });
      const command = {
        eventSlug: fixture.eventSlug,
        installationId: reviewer.installationId,
        reason: "End of my shift",
        clientOperationId: "venue-departure",
      };
      await expect(
        reviewer.identity.mutation(api.reviewerVenue.declareDeparture, command),
      ).rejects.toThrow("Finish the current review");
      expect(
        (await backend.run((ctx) => ctx.db.get(clockIn.clockInId)))?.status,
      ).toBe("present");
      await reviewer.identity.mutation(api.reviewerVenue.setMonitoring, {
        ownerId: reviewer.authUserId,
        eventSlug: fixture.eventSlug,
        installationId: reviewer.installationId,
        enabled: true,
        clientOperationId: "voice-presence",
      });
      const callId = await backend.run(async (ctx) => {
        const now = Date.now();
        const presence = await ctx.db
          .query("reviewerVenuePresence")
          .withIndex("by_eventId_personId", (q) =>
            q
              .eq("eventId", fixture.eventId)
              .eq("personId", fixture.memberPersonId),
          )
          .unique();
        if (!presence) throw new Error("Missing venue presence");
        const departureId = await ctx.db.insert("reviewerVenueDepartures", {
          eventId: fixture.eventId,
          personId: fixture.memberPersonId,
          presenceId: presence._id,
          policyVersion: 1,
          state: "open",
          leftAt: now,
          notificationState: "sent",
          notificationAttempts: 1,
          updatedAt: now,
        });
        const consentId = await ctx.db.insert("outboundCallConsents", {
          eventId: fixture.eventId,
          personId: fixture.memberPersonId,
          purpose: "reviewer_venue_absence",
          state: "granted",
          consentPolicyVersion: "test",
          scriptPolicyVersion: "test",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        const callId = await ctx.db.insert("outboundCallDeliveries", {
          eventId: fixture.eventId,
          targetPersonId: fixture.memberPersonId,
          sourceType: "reviewer_venue_departure",
          sourceId: departureId,
          purpose: "reviewer_venue_absence",
          script: "Confirm venue presence",
          locale: "en-IN",
          scriptPolicyVersion: "test",
          consentId,
          consentVersion: 1,
          authorizationGrantIds: [],
          state: "provider_accepted",
          attemptCount: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
          venueConfirmation: {
            appId: "test",
            appVersion: 1,
            reviewerName: "Reviewer",
            venueName: "Hall",
            expiresAt: now + 600000,
          },
        });
        await ctx.db.patch(departureId, { callDeliveryId: callId });
        await ctx.db.patch(presence._id, {
          status: "left",
          observation: "outside",
          sampledAt: now,
          departureId,
        });
        return callId;
      });
      await backend.mutation(internal.outboundCallState.recordProviderEvent, {
        providerEventId: crypto.randomUUID(),
        deliveryId: callId,
        eventType: "call.completed",
        providerAt: Date.now(),
        providerCallId: "call-1",
        venueResponse: {
          outcome: "away",
          confirmed: true,
          summary: "Reviewer says they need to leave",
          returnInMinutes: null,
          transcript: [{ role: "user", text: "Yes, I need to leave." }],
        },
      });
      expect(
        (await backend.run((ctx) => ctx.db.get(callId)))?.venueResponseEffect,
      ).toBe("needs_ops");
      expect(
        (await backend.run((ctx) => ctx.db.get(clockIn.clockInId)))?.status,
      ).toBe("present");
      await backend.run((ctx) =>
        ctx.db.patch(sessionId, {
          status: "completed",
          completedAt: Date.now(),
        }),
      );
      await reviewer.identity.mutation(
        api.reviewerVenue.declareDeparture,
        command,
      );
      await reviewer.identity.mutation(
        api.reviewerVenue.declareDeparture,
        command,
      );
      expect(
        await backend.run((ctx) => ctx.db.get(clockIn.clockInId)),
      ).toMatchObject({ status: "clocked_out", version: clockIn.version + 1 });
      expect(
        await backend.run((ctx) =>
          ctx.db.query("reviewerVenueDepartures").collect(),
        ),
      ).toHaveLength(1);
      await reviewer.identity.mutation(api.reviewer.clockIn, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        expectedVersion: clockIn.version + 1,
        clientOperationId: "return-to-duty",
      });
      expect(
        (await backend.run((ctx) => ctx.db.get(clockIn.clockInId)))?.status,
      ).toBe("present");
      expect(
        (
          await backend.run((ctx) =>
            ctx.db.query("reviewerVenueDepartures").collect(),
          )
        )[0]?.state,
      ).toBe("returned");
    },
  );

  test("returning from a break rechecks the reviewer's latest confirmed hours", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const clockIn = await reviewer.identity.mutation(api.reviewer.clockIn, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      expectedVersion: 0,
      clientOperationId: "confirm-return-clock-in",
    });
    await reviewer.identity.mutation(api.reviewer.setAvailability, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      installationId: reviewer.installationId,
      status: "temporarily_unavailable",
      reason: "Taking a short break.",
      expectedReturnMinutes: 10,
      expectedVersion: clockIn.version,
      clientOperationId: "confirm-return-break",
    });
    await reviewer.identity.mutation(api.reviewConfirmations.respond, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      windows: [],
      expectedVersion: 1,
      clientOperationId: "confirm-return-decline",
    });
    await expect(
      reviewer.identity.mutation(api.reviewer.setAvailability, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        installationId: reviewer.installationId,
        status: "present",
        expectedVersion: 2,
        clientOperationId: "confirm-return-blocked",
      }),
    ).rejects.toThrow("Confirm your availability");
    expect(
      await backend.run((ctx) => ctx.db.get(clockIn.clockInId)),
    ).toMatchObject({
      status: "temporarily_unavailable",
      version: 2,
    });
  });

  test("a previous team scan does not let an off-duty reviewer start a review", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewSessionId = await seedLiveReview(backend, fixture);
    await backend.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(reviewSessionId, { status: "awaiting_presence" });
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .collect();
      for (const member of members) {
        await ctx.db.insert("reviewAssignments", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId: fixture.panelId,
          reviewSessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: now,
        });
        await ctx.db.insert("reviewPresence", {
          eventId: fixture.eventId,
          reviewSessionId,
          reviewerPersonId: member.personId,
          method: "qr",
          tokenVersion: 1,
          confirmedAt: now,
        });
      }
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.operatorPersonId,
        eventAccessSubjectId: fixture.operatorSubjectId,
        permissionKey: "review.start",
        scopeType: "review",
        scopeId: reviewSessionId,
        sourceType: "manual",
        sourceId: `start:${reviewSessionId}`,
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Review start presence check",
      });
    });
    await expect(
      asOperator(backend, fixture).mutation(api.reviewOperations.startReview, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
        expectedVersion: 1,
        reason: "Everyone previously scanned.",
        clientOperationId: "start-off-duty",
      }),
    ).rejects.toThrow("must still be on duty");
    expect(
      await backend.run((ctx) => ctx.db.get(reviewSessionId)),
    ).toMatchObject({
      status: "awaiting_presence",
      version: 1,
    });
  });

  test("does not accept an early confirmation or a window outside the round", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const requestId = await backend.run(async (ctx) => {
      const request = await ctx.db
        .query("reviewConfirmationRequests")
        .withIndex("by_roundId", (q) => q.eq("roundId", fixture.roundId))
        .unique();
      if (!request) throw new Error("Request missing.");
      await ctx.db.patch(request._id, {
        state: "scheduled",
        opensAt: Date.now() + 60_000,
      });
      return request._id;
    });
    const args = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      windows: [],
      expectedVersion: 1,
      clientOperationId: "early-confirmation",
    };
    await expect(
      reviewer.identity.mutation(api.reviewConfirmations.respond, args),
    ).rejects.toThrow("not open");
    await backend.run((ctx) =>
      ctx.db.patch(requestId, { opensAt: Date.now() - 1 }),
    );
    await expect(
      reviewer.identity.mutation(api.reviewConfirmations.respond, {
        ...args,
        windows: [{ startsAt: 1, endsAt: 700_000 }],
        clientOperationId: "invalid-window",
      }),
    ).rejects.toThrow("within this round");
  });

  test("notification claims serialize retries and stop after access is revoked", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const notificationId = await backend.run(async (ctx) => {
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("personId", fixture.memberPersonId),
        )
        .unique();
      const device = await ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_installation", (q) =>
          q
            .eq("eventId", fixture.eventId)
            .eq("installationId", reviewer.installationId),
        )
        .unique();
      if (!confirmation || !device)
        throw new Error("Confirmation device missing.");
      await ctx.db.patch(confirmation._id, { status: "pending", windows: [] });
      await ctx.db.patch(device._id, {
        pushTokenStatus: "active",
        pushToken: "fixture-token",
        pushProvider: "fcm",
        pushEnvironment: "development",
      });
      return ctx.db.insert("reviewConfirmationNotifications", {
        confirmationId: confirmation._id,
        purpose: "availability",
        confirmationVersion: confirmation.version,
        state: "pending",
        attempts: 0,
        updatedAt: Date.now(),
      });
    });
    expect(
      await backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId,
        attemptId: "first",
      }),
    ).toMatchObject({ provider: "fcm" });
    expect(
      await backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId,
        attemptId: "duplicate",
      }),
    ).toBeNull();
    await backend.mutation(internal.reviewConfirmationPushState.finish, {
      notificationId,
      attemptId: "duplicate",
      ok: true,
    });
    expect(
      (await backend.run((ctx) => ctx.db.get(notificationId)))?.state,
    ).toBe("sending");
    await backend.mutation(internal.reviewConfirmationPushState.finish, {
      notificationId,
      attemptId: "first",
      ok: false,
      retryable: true,
      errorCode: "provider_busy",
    });
    await backend.run(async (ctx) => {
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (q) =>
          q
            .eq("eventAccessSubjectId", fixture.memberSubjectId)
            .eq("permissionKey", "reviewer.clock_in")
            .eq("status", "active"),
        )
        .collect();
      for (const grant of grants)
        await ctx.db.patch(grant._id, { status: "revoked" });
    });
    expect(
      await backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId,
        attemptId: "after-revoke",
      }),
    ).toBeNull();
    expect(
      (await backend.run((ctx) => ctx.db.get(notificationId)))?.state,
    ).toBe("cancelled");
  });

  test("opens the app request once and cancels stale push after a response", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const reviewer = await prepareReviewerClockIn(backend, fixture);
    const ids = await backend.run(async (ctx) => {
      const request = await ctx.db
        .query("reviewConfirmationRequests")
        .withIndex("by_roundId", (q) => q.eq("roundId", fixture.roundId))
        .unique();
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q
            .eq("roundId", fixture.roundId)
            .eq("personId", fixture.memberPersonId),
        )
        .unique();
      if (!request || !confirmation) throw new Error("Request missing.");
      await ctx.db.patch(request._id, { state: "scheduled" });
      await ctx.db.patch(confirmation._id, { status: "pending", windows: [] });
      return { requestId: request._id, confirmationId: confirmation._id };
    });
    await backend.mutation(internal.reviewConfirmations.openRequest, {
      requestId: ids.requestId,
    });
    await backend.mutation(internal.reviewConfirmations.openRequest, {
      requestId: ids.requestId,
    });
    const notification = await backend.run((ctx) =>
      ctx.db
        .query("reviewConfirmationNotifications")
        .withIndex("by_confirmationId", (q) =>
          q.eq("confirmationId", ids.confirmationId),
        )
        .unique(),
    );
    if (!notification) throw new Error("Notification missing.");
    await reviewer.identity.mutation(api.reviewConfirmations.respond, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      windows: [],
      expectedVersion: 1,
      clientOperationId: "decline-before-push",
    });
    expect(
      await backend.mutation(internal.reviewConfirmationPushState.claim, {
        notificationId: notification._id,
        attemptId: "stale-push",
      }),
    ).toBeNull();
    expect(
      (await backend.run((ctx) => ctx.db.get(notification._id)))?.state,
    ).toBe("cancelled");
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
    authUserId,
    identity: backend.withIdentity({ subject: authUserId, sessionId: authSessionId,
    }),
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

function publicationRequest(
  fixture: Fixture,
  startsAt: number,
  personId: Id<"people">,
): FunctionArgs<typeof api.reviewConfiguration.publishRound> {
  return {
    eventSlug: fixture.eventSlug,
    confirmationOpensAt: startsAt - 2 * 60 * 60_000,
    rubric: {
      name: "Availability fixture rubric",
      spreadThreshold: 2,
      criteria: [
        {
          stableKey: "craft",
          label: "Craft",
          question: "How strong is the demonstrated craft?",
          guidance: "Use only the fixed evidence shown by the team.",
          weight: 100,
          displayOrder: 0,
          anchors: {
            zero: "None",
            one: "Weak",
            two: "Sound",
            three: "Strong",
            four: "Exceptional",
          },
        },
      ],
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
      staffing: {
        seniorSeats: 0,
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
    },
    panels: [
      {
        stableKey: "availability_panel",
        name: "Availability panel",
        members: [
          {
            personId,
            criterionKeys: ["craft"],
            isCoordinator: true,
          },
        ],
      },
    ],
    reservePersonIds: [],
    reason: "Exercise reviewer publication",
    clientOperationId: "publish-reviewer",
  };
}

async function preparePublicationPolicy(backend: BackendTest, fixture: Fixture,
) {
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
        .then((rows) => rows.filter((row) => row.eventId === fixture.eventId),
          ),
      ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId),
          )
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
      panel: panel && { status: panel.status, version: panel.version, updatedAt: panel.updatedAt,
      },
      clockIns: clockIns.map((clockIn) => ({
        id: clockIn._id,
        status: clockIn.status,
        version: clockIn.version,
        lastHeartbeatAt: clockIn.lastHeartbeatAt,
      })),
      operationResultIds: operationResults.map((result) => result._id),
      auditEventIds: auditEvents.map((event) => event._id),
      device: device && { version: device.version, lastSeenAt: device.lastSeenAt,
      },
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
    const operator = await insertAccount(ctx, eventId, "operator", now, authUserId,
    );
    const criterionKeys = ["craft", "impact"];
    const reviewers = new Map<
      string,
      { personId: Id<"people">; subjectId: Id<"eventAccessSubjects"> }
    >();
    for (const key of ["coordinator", "member", "second-member", "reserve"]) {
      const account = await insertAccount(ctx, eventId, key, now);
      await ctx.db.insert("reviewerProfiles", {
        eventId,
        personId: account.personId,
        seniority: "sc",
        strength: 2,
        technicalDomains: ["backend"],
        productDomains: ["operations"],
        languages: ["english"],
        criterionKeys,
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
    await ctx.db.insert("reviewConfirmationRequests", {
      eventId,
      roundId,
      opensAt: now - 3_600_000,
      state: "open",
      version: 1,
      createdAt: now,
    });
    for (const account of reviewers.values()) {
      await ctx.db.insert("reviewerRoundConfirmations", {
        eventId,
        roundId,
        personId: account.personId,
        status: "confirmed",
        windows: [{ startsAt: now - 7_200_000, endsAt: now + 14_400_000 }],
        version: 1,
        respondedAt: now,
        updatedAt: now,
      });
    }
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
        seatSeniority: key === "coordinator" ? "lead" : "sc",
      });
      panelMemberIds.set(key, panelMemberId);
      for (const permissionKey of ["reviewer.clock_in", "round.read",
      ] as const) {
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
      memberSubjectId: member.subjectId,
      secondMemberPersonId: secondMember.personId,
      reservePersonId: reserve.personId,
      reserveSubjectId: reserve.subjectId,
      reserveId,
      authUserId,
      authSessionId,
    };
  });
}

async function seedLiveReview(backend: BackendTest, fixture: Fixture) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const participant = await insertAccount(ctx, fixture.eventId, "participant", now,
    );
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
      mixedParticipantClassesAllowed: false,
      phoneVerificationEnabled: false,
      vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
      profileNotice: "Fixture profile notice.",
      projectTextNotice: "Fixture project notice.",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "Fixture attestation.",
      finalSubmissionWarning: "Fixture warning.",
      checksum: "fixture-participant-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    },
    );
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
    },
    );
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
    },
    );
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
