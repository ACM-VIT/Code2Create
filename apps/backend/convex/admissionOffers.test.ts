import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";

import { internal, components } from "./_generated/api.js";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import type { Id } from "./_generated/dataModel.js";
import { createAdmissionOffer, transitionOffer } from "./admissions.ts";
import { insertPermissionGrant } from "./lib/permissions";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy.ts";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy.ts";
import schema from "./schema.ts";

const admissionRsvpCallDelayMs = 8.5 * 60 * 60_000;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob("../node_modules/@convex-dev/better-auth/src/component/**/*.ts");

type BackendTest = TestConvex<typeof schema>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("admission offer lifecycle", () => {
  test.each(["expired", "pending"] as const)("records a %s manual RSVP once, preserves capacity history and sends no messages", async status => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() - 1);
    if (status === "expired") await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId, expectedOfferVersion: 1,
    });
    const operator = await prepareManualRsvp(backend, fixture);
    const before = await readOfferState(backend, fixture);
    if (!before.application || !before.offer || !before.team) throw new Error("Missing fixture");
    const beforeNotifications = await scheduledRosterNotificationCount(backend);
    const args = { eventSlug: operator.eventSlug, applicationId: fixture.applicationId,
      expectedApplicationVersion: before.application.version, expectedOfferVersion: before.offer.version,
      expectedTeamVersion: before.team.version, reason: "Organizer received the team's manual RSVP in person.",
      clientOperationId: `manual-${status}` };
    const result = await operator.client.mutation(internal.admissions.recordManualRsvp, args);
    expect(result).toMatchObject({ offerState: "confirmed", applicationState: "confirmed" });
    expect(await operator.client.mutation(internal.admissions.recordManualRsvp, args)).toEqual(result);
    expect(await operator.client.mutation(internal.admissions.recordManualRsvp, {
      ...args, clientOperationId: `manual-${status}-again`,
    })).toEqual(result);
    // A late expiry worker for the original offer cannot undo the manual RSVP.
    await backend.mutation(internal.admissions.expireOffer, { offerId: fixture.offerId, expectedOfferVersion: 1 });
    await updateRosterStatus(backend, fixture, "accepted");
    const after = await readOfferState(backend, fixture);
    expect(after.application?.state).toBe("confirmed");
    expect(after.team?.status).toBe("confirmed");
    expect(after.membership?.onboardingStatus).toBe("accepted");
    expect(after.capacity?.reserved).toBe(1);
    expect(after.teamAvailability).not.toBeNull();
    expect(after.audits.filter(a => a.action === "admission.rsvp_manually_confirmed")).toMatchObject([
      { actorPersonId: operator.personId, reason: args.reason },
    ]);
    if (status === "expired") {
      expect(result.offerId).not.toBe(fixture.offerId);
      expect(after.offer).toEqual(before.offer);
      expect(after.reservation).toEqual(before.reservation);
    } else expect(result.offerId).toBe(fixture.offerId);
    expect(await scheduledRosterNotificationCount(backend)).toBe(beforeNotifications);
    expect(await rsvpCalls(backend)).toEqual([]);
    const active = await backend.run(ctx => ctx.db.query("admissionCapacityReservations")
      .withIndex("by_application_state", q => q.eq("applicationId", fixture.applicationId).eq("state", "active")).collect());
    expect(active).toMatchObject([{ offerId: result.offerId, participantCount: 1 }]);
  });

  test.each(["authority", "version", "capacity", "declined", "rejected", "external", "ineligible"] as const)(
    "refuses manual RSVP with changed %s and rolls back all writes", async invalid => {
      const backend = convexTest(schema, modules);
      const fixture = await seedOfferedApplication(backend, Date.now() - 1);
      await backend.mutation(internal.admissions.expireOffer, { offerId: fixture.offerId, expectedOfferVersion: 1 });
      const operator = await prepareManualRsvp(backend, fixture);
      await backend.run(async ctx => {
        if (invalid === "authority") await ctx.db.patch(operator.grantId, { status: "revoked" });
        if (invalid === "capacity") await ctx.db.patch(fixture.capacityId, { capacity: 0 });
        if (invalid === "declined") {
          await ctx.db.patch(fixture.applicationId, { state: "withdrawn" });
          await ctx.db.patch(fixture.offerId, { state: "declined" });
        }
        if (invalid === "rejected") await ctx.db.patch(fixture.applicationId, { humanDecision: "decline" });
        if (invalid === "external") await ctx.db.patch(fixture.teamId, { activeVitMemberCount: 0, activeExternalMemberCount: 1 });
        if (invalid === "ineligible") await ctx.db.patch(fixture.membershipId, { eligibilityStatus: "suspended" });
      });
      const before = await readOfferState(backend, fixture);
      if (!before.application || !before.offer || !before.team) throw new Error("Missing fixture");
      await expect(operator.client.mutation(internal.admissions.recordManualRsvp, {
        eventSlug: operator.eventSlug, applicationId: fixture.applicationId,
        expectedApplicationVersion: before.application.version + (invalid === "version" ? 1 : 0),
        expectedOfferVersion: before.offer.version, expectedTeamVersion: before.team.version,
        reason: "Manual RSVP requested by organizer.", clientOperationId: `invalid-${invalid}`,
      })).rejects.toThrow();
      expect(await readOfferState(backend, fixture)).toEqual(before);
      expect(await backend.run(ctx => ctx.db.query("admissionOffers").collect())).toHaveLength(1);
    },
  );

  test("renders the event date and time in VIT RSVP confirmation emails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T08:30:00Z"));
    vi.stubEnv("PARTICIPANT_SITE_URL", "https://c2c.sh");
    vi.stubEnv("EMAIL_SERVICE_URL", "https://email.example.test");
    vi.stubEnv("EMAIL_SEND_INGRESS_SECRET", "rsvp-email-fixture-secret-at-least-thirty-two-characters");
    let sentBody = "";
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") sentBody = init.body;
      return Response.json({ status: "accepted", provider: "cloudflare_email", messageId: "rsvp-confirmed-message", initialOutcome: "queued" });
    });
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await backend.run(async ctx => {
      const [application, offer, project, team] = await Promise.all([
        ctx.db.get(fixture.applicationId), ctx.db.get(fixture.offerId), ctx.db.get(fixture.projectId), ctx.db.get(fixture.teamId),
      ]);
      if (!application || !offer || !project || !team) throw new Error("Missing RSVP fixture");
      await transitionOffer(ctx, { application, offer, project, team, transition: "confirmed", actorPersonId: fixture.personId, reason: "Team lead confirmed RSVP", now: Date.now() });
    });
    const application = await backend.run(ctx => ctx.db.get(fixture.applicationId));
    if (!application) throw new Error("Missing confirmed application");
    await enqueueRosterNotification(backend, fixture, "offer_confirmed", application.version);
    const state = await readOfferState(backend, fixture);
    const delivery = state.deliveries.find(d => d.templateKey === "offer_confirmed");
    if (!delivery) throw new Error("Missing confirmation email");
    await backend.action(internal.participantEmail.deliver, { deliveryId: delivery._id });
    const request: unknown = JSON.parse(sentBody);
    expect(request).toMatchObject({
      text: expect.stringContaining("When: 6 September 2026 at 2:00 pm IST"),
      html: expect.stringContaining("When: 6 September 2026 at 2:00 pm IST"),
    });
    expect((await readOfferState(backend, fixture)).deliveries.find(d => d._id === delivery._id)?.state).toBe("sent");
  });

  test("only exposes exact application management and exact-team response scopes", () => {
    expect(permissionCatalog["application.offer.manage"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.offer.respond"]).toEqual({
      scopes: ["team"],
      eventWide: false,
    });
  });

  test("rejects admission evidence that is absent from the submitted intake", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    const recommendationId = await backend.run((ctx) =>
      ctx.db.insert("admissionAIRecommendations", {
        eventId: fixture.eventId,
        applicationId: fixture.applicationId,
        teamId: fixture.teamId,
        projectVersionId: fixture.projectId,
        admissionPolicyVersionId: fixture.policyId,
        applicationContentVersion: 1,
        sourceInputFingerprint: "admission-source-v1",
        experienceBand: "mixed_or_external",
        state: "running",
        criterionAssessments: [],
        strengths: [],
        concerns: [],
        limitations: [],
        createdAt: Date.now(),
      }),
    );
    await backend.run((ctx) =>
      ctx.db.patch(fixture.applicationId, { aiRecommendationId: recommendationId }),
    );
    await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
      recommendationId,
      sourceInputFingerprint: "admission-source-v1",
      state: "succeeded",
      recommendation: "accept",
      centralProposalConsistency: {
        assessment: "consistent",
        sourceRefs: ["follow_up_2"],
      },
      criterionAssessments: [
        {
          criterionKey: "intent",
          assessment: "meets",
          sourceRefs: ["follow_up_2"],
        },
      ],
      strengths: ["The intended venue workflow is clear."],
      concerns: [],
      confidence: "medium",
      limitations: [],
      latencyMs: 20,
    });
    const state = await backend.run(async (ctx) => ({
      recommendation: await ctx.db.get(recommendationId),
      application: await ctx.db.get(fixture.applicationId),
    }));
    expect(state.recommendation).toMatchObject({
      state: "invalid",
      failureCategory: "invalid_completion_payload",
      criterionAssessments: [],
    });
    expect(state.application?.aiDisposition).toBe("unavailable");
  });

  test("sending an offer reserves only the locked roster and moves it to offer pending", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);
    await updateRosterStatus(backend, fixture, "offer_pending");
    const state = await readOfferState(backend, fixture);

    expect(state.application).toMatchObject({
      state: "offer_sent",
      version: 3,
      currentOfferId: fixture.offerId,
    });
    expect(state.offer).toMatchObject({
      state: "offered",
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
      participantCount: 1,
    });
    expect(state.membership?.onboardingStatus).toBe("offer_pending");
    expect(state.reservation).toMatchObject({
      offerId: fixture.offerId,
      state: "active",
      participantCount: 1,
    });
    expect(state.capacity).toMatchObject({ reserved: 1, version: 2 });
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      templateKey: "offer",
      applicationVersion: 3,
    });
    const invitation = state.deliveries[0];
    if (!invitation) throw new Error("Missing RSVP invitation");
    const claim = await backend.mutation(internal.participantNotificationState.claimDelivery, { deliveryId: invitation._id, attemptId: "rsvp-email-deadline" });
    expect(claim?.rsvpDeadline).toBe(state.offer?.expiresAt);
    expect(claim?.textTemplate).toContain("{{rsvp_deadline}}");
  });

  test("confirmation preserves the exact reservation and defeats a stale expiry", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.run(async (ctx) => {
      const [application, offer, project, team] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.offerId),
        ctx.db.get(fixture.projectId),
        ctx.db.get(fixture.teamId),
      ]);
      if (!application || !offer || !project || !team)
        throw new Error("Offer fixture is incomplete.");
      await transitionOffer(ctx, {
        application,
        offer,
        project,
        team,
        transition: "confirmed",
        actorPersonId: fixture.personId,
        reason: "Fixture confirmation",
        now: Date.now(),
      });
    });
    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await enqueueRosterNotification(backend, fixture, "offer_confirmed", 4);
    const externalPassJobsBefore = await scheduledRosterNotificationCount(backend);
    await updateRosterStatus(backend, fixture, "accepted", fixture.communicationsPolicyId);
    expect(await scheduledRosterNotificationCount(backend)).toBe(externalPassJobsBefore + 1);

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({ state: "confirmed", version: 4 });
    expect(state.offer).toMatchObject({
      state: "confirmed",
      version: 2,
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    });
    expect(state.team).toMatchObject({ status: "confirmed", version: 3 });
    expect(state.membership?.onboardingStatus).toBe("accepted");
    expect(state.teamAvailability).toMatchObject({
      activeMemberCount: 1,
      insideMemberCount: 0,
      version: 1,
    });
    expect(state.reservation).toMatchObject({ state: "active", participantCount: 1 });
    expect(state.capacity).toMatchObject({ reserved: 1, version: 2 });
    expect(state.deliveries).toHaveLength(2);
    expect(
      state.deliveries.find((delivery) => delivery.templateKey === "offer_confirmed"),
    ).toMatchObject({
      templateKey: "offer_confirmed",
      applicationVersion: 4,
      state: "pending",
    });
  });

  test("expiry releases capacity once and keeps a repeated worker idempotent", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() - 1);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await enqueueRosterNotification(backend, fixture, "offer_expired", 4);
    await updateRosterStatus(backend, fixture, "submitted");

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({ state: "offer_expired", version: 4 });
    expect(state.offer).toMatchObject({ state: "expired", version: 2 });
    expect(state.team).toMatchObject({ status: "withdrawn", version: 3 });
    expect(state.membership?.onboardingStatus).toBe("submitted");
    expect(state.reservation).toMatchObject({
      state: "released",
      releasedReason: "offer_expired",
    });
    expect(state.capacity).toMatchObject({ reserved: 0, version: 3 });
    expect(state.deliveries).toHaveLength(2);
    expect(
      state.deliveries.find((delivery) => delivery.templateKey === "offer_expired"),
    ).toMatchObject({
      templateKey: "offer_expired",
      applicationVersion: 4,
    });
    expect(state.audits.filter((entry) => entry.action === "admission.offer_expired")).toHaveLength(
      1,
    );
  });

  test("declining releases capacity but never changes the locked roster", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.run(async (ctx) => {
      const [application, offer, project, team] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.offerId),
        ctx.db.get(fixture.projectId),
        ctx.db.get(fixture.teamId),
      ]);
      if (!application || !offer || !project || !team)
        throw new Error("Offer fixture is incomplete.");
      await transitionOffer(ctx, {
        application,
        offer,
        project,
        team,
        transition: "declined",
        actorPersonId: fixture.personId,
        reason: "Fixture decline",
        now: Date.now(),
      });
    });
    await enqueueRosterNotification(backend, fixture, "offer_declined", 4);
    await updateRosterStatus(backend, fixture, "submitted");

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({
      state: "withdrawn",
      currentOfferId: fixture.offerId,
    });
    expect(state.offer).toMatchObject({ state: "declined" });
    expect(state.team).toMatchObject({
      status: "withdrawn",
      membershipLocked: true,
      lockedProjectVersionId: fixture.projectId,
    });
    expect(state.membership?.onboardingStatus).toBe("submitted");
    expect(state.reservation).toMatchObject({
      state: "released",
      releasedReason: "offer_declined",
    });
    expect(state.capacity?.reserved).toBe(0);
  });
});

describe("automatic RSVP reminder calls", () => {
  test("external teams receive neither RSVP invitations nor reminder calls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, now + 12 * 60 * 60_000, now + admissionRsvpCallDelayMs);
    await prepareRsvpCall(backend, fixture);
    await backend.run(ctx => ctx.db.patch(fixture.membershipId, { participantClass: "external_participant" }));
    await enqueueRosterNotification(backend, fixture, "offer", 3);
    expect((await readOfferState(backend, fixture)).deliveries).toHaveLength(0);
    vi.setSystemTime(now + admissionRsvpCallDelayMs);
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
    expect(await rsvpCalls(backend)).toEqual([]);
  });

  test("rejects a reminder at or after the response deadline", async () => {
    const backend = convexTest(schema, modules);
    const deadline = Date.now() + 60_000;
    await expect(seedOfferedApplication(backend, deadline, deadline)).rejects.toThrow("before RSVP closes");
  });

  test("schedules at the configured time and dispatches one call through the voice worker without opt-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, now + 12 * 60 * 60_000, now + admissionRsvpCallDelayMs);
    await prepareRsvpCall(backend, fixture);
    const jobs = await backend.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const reminder = jobs.find((job) => job.name === "admissionOfferCalls:remind");
    expect(reminder).toMatchObject({
      args: [{ offerId: fixture.offerId }],
      scheduledTime: now + admissionRsvpCallDelayMs,
    });
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
    expect(await rsvpCalls(backend)).toEqual([]);

    vi.setSystemTime(now + admissionRsvpCallDelayMs);
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
    const calls = await rsvpCalls(backend);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("The unanswered offer did not queue a reminder.");
    expect(call).toMatchObject({
      sourceId: fixture.offerId,
      sourceType: "admission_offer_reminder",
      targetPersonId: fixture.personId,
      destinationPhoneE164: "+919876543210",
      state: "pending",
    });
    expect(call.consentId).toBeUndefined();
    expect(await backend.run((ctx) => ctx.db.query("outboundCallConsents").collect())).toEqual([]);
    expect(call.script).toContain("Quiet Circuit");
    expect(call.script).toContain("confirm or decline for your whole team");
    expect(call.script.length).toBeLessThanOrEqual(600);

    vi.stubEnv("OUTBOUND_CALL_WORKER_URL", "https://voice.example.test");
    vi.stubEnv("CONVEX_SITE_URL", "https://api.example.test");
    vi.stubEnv("OUTBOUND_CALL_REQUEST_SECRET", "a".repeat(64));
    const dispatch = vi.fn(async () => new Response(JSON.stringify({
      accepted: true, deliveryId: call._id,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", dispatch);
    await backend.action(internal.outboundCalls.deliver, { deliveryId: call._id });
    await backend.action(internal.outboundCalls.deliver, { deliveryId: call._id });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(new URL("https://voice.example.test/v1/calls"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining(call.script) }));
    expect(await backend.run((ctx) => ctx.db.get(call._id))).toMatchObject({ state: "provider_accepted" });
  });

  test("postpones an already queued call and uses the current RSVP deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, now + 12 * 60 * 60_000, now + admissionRsvpCallDelayMs);
    await prepareRsvpCall(backend, fixture);
    vi.setSystemTime(now + admissionRsvpCallDelayMs);
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
    const [call] = await rsvpCalls(backend);
    if (!call) throw new Error("Missing queued call");
    const reminderAt = now + admissionRsvpCallDelayMs + 60_000;
    await backend.run(ctx => ctx.db.patch(fixture.offerId, { reminderAt, expiresAt: now + 13 * 60 * 60_000 }));
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, { deliveryId: call._id, attemptId: "early" })).toBeNull();
    expect(await backend.run(ctx => ctx.db.get(call._id))).toMatchObject({ state: "retry_wait", nextAttemptAt: reminderAt, attemptCount: 0 });
    vi.setSystemTime(reminderAt);
    const claim = await backend.mutation(internal.outboundCallState.claimDelivery, { deliveryId: call._id, attemptId: "due" });
    expect(claim?.script).not.toBe(call.script);
    expect((await backend.run(ctx => ctx.db.get(call._id)))?.script).toBe(claim?.script);
  });

  test("does not schedule a reminder after a short offer's deadline", async () => {
    const backend = convexTest(schema, modules);
    await seedOfferedApplication(backend, Date.now() + 60_000);
    const jobs = await backend.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name === "admissionOfferCalls:remind")).toBe(false);
  });

  test.each(["confirmed", "declined", "expired", "revoked"] as const)(
    "%s offers cancel queued reminders and cannot enqueue another call",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.now();
      const backend = convexTest(schema, modules);
      const fixture = await seedOfferedApplication(backend, now + 12 * 60 * 60_000, now + admissionRsvpCallDelayMs);
      await prepareRsvpCall(backend, fixture);
      vi.setSystemTime(now + admissionRsvpCallDelayMs);
      await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
      const [call] = await rsvpCalls(backend);
      if (!call) throw new Error("Expected one queued reminder.");
      await backend.run(async (ctx) => {
        const [application, offer, project, team] = await Promise.all([
          ctx.db.get(fixture.applicationId), ctx.db.get(fixture.offerId),
          ctx.db.get(fixture.projectId), ctx.db.get(fixture.teamId),
        ]);
        if (!application || !offer || !project || !team) throw new Error("Missing offer fixture.");
        await transitionOffer(ctx, {
          application, offer, project, team, transition,
          actorPersonId: fixture.personId, reason: "RSVP response before reminder dispatch", now: Date.now(),
        });
      });
      await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
      expect(await rsvpCalls(backend)).toHaveLength(1);
      expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
        deliveryId: call._id, attemptId: crypto.randomUUID(),
      })).toBeNull();
      expect(await backend.run((ctx) => ctx.db.get(call._id))).toMatchObject({
        state: "cancelled", providerErrorCode: "rsvp_offer_no_longer_pending",
      });
    },
  );

  test.each(["phone", "authority", "deadline"] as const)(
    "rechecks %s changes before dispatch and before creating a reminder",
    async (change) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.now();
      const backend = convexTest(schema, modules);
      const fixture = await seedOfferedApplication(backend, now + 12 * 60 * 60_000, now + admissionRsvpCallDelayMs);
      const setup = await prepareRsvpCall(backend, fixture);
      vi.setSystemTime(now + admissionRsvpCallDelayMs);
      await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
      const [call] = await rsvpCalls(backend);
      if (!call) throw new Error("Expected one queued reminder.");
      if (change === "deadline") vi.setSystemTime(now + 12 * 60 * 60_000);
      else await backend.run(async (ctx) => {
        if (change === "phone") await ctx.db.delete(setup.profileId);
        else await ctx.db.patch(setup.grantId, { status: "revoked" });
      });
      expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
        deliveryId: call._id, attemptId: crypto.randomUUID(),
      })).toBeNull();
      expect(await backend.run((ctx) => ctx.db.get(call._id))).toMatchObject({ state: "cancelled" });
      // Remove the prior delivery so deduplication cannot conceal a broken eligibility check.
      await backend.run((ctx) => ctx.db.delete(call._id));
      await backend.mutation(internal.admissionOfferCalls.remind, { offerId: fixture.offerId });
      expect(await rsvpCalls(backend)).toEqual([]);
    },
  );
});

async function prepareRsvpCall(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
) {
  return backend.run(async (ctx) => {
    const membership = await ctx.db.get(fixture.membershipId);
    if (!membership) throw new Error("The RSVP lead membership is missing.");
    const { grantId } = await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: membership.eventAccessSubjectId,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: fixture.applicationId,
      sourceType: "manual",
      sourceId: "rsvp-offer-test",
      reason: "Offer reminder test",
    });
    await ctx.db.patch(fixture.offerId, { createdByGrantIds: [grantId] });
    const profileId = await ctx.db.insert("participantProfiles", {
      eventId: fixture.eventId, membershipId: fixture.membershipId,
      participantClass: "vit_student", fullName: "Aarav Menon",
      phone: "+91 98765 43210", gender: "male", institution: "Example University",
      yearOfStudy: "not_applicable", profileVersion: 1, updatedAt: Date.now(),
    });
    return { grantId, profileId };
  });
}

function rsvpCalls(backend: BackendTest) {
  return backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect());
}

async function seedOfferedApplication(backend: BackendTest, expiresAt: number, reminderAt?: number) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const startsAt = now + 24 * 60 * 60 * 1_000;
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    const eventId = await ctx.db.insert("events", {
      slug: `offer-fixture-${Math.abs(expiresAt)}`,
      name: "Code2Create offer fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt,
      endsAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `offer-user-${expiresAt}`,
      googleSubject: `offer-subject-${expiresAt}`,
      verifiedEmail: `offer-${Math.abs(expiresAt)}@example.test`,
      displayName: "Aarav Menon",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: participantPolicyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `offer-${Math.abs(expiresAt)}@example.test`,
      displayName: "Aarav Menon",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "selected",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Quiet Circuit",
      publicCode: "OFFER01",
      leadMembershipId: membershipId,
      status: "admitted",
      activeMemberCount: 1,
      activeVitMemberCount: 1,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 2,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const policyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [
        {
          criterionKey: "intent",
          label: "Intent",
          guidanceByBand: {
            firstYear: "The team explains a genuine problem and workable basic idea.",
            earlyYear: "The team explains a genuine problem and a coherent event-sized idea.",
            laterYear:
              "The team explains a clear problem, scope, feasibility, and differentiation.",
            postgraduateOrProfessional:
              "The team explains a credible plan, trade-offs, and differentiation.",
            mixedOrExternal: "The team explains a clear problem and workable event-sized approach.",
          },
        },
      ],
      decisionReasonCodes: [],
      checksum: "offer-policy",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultDeterministicIntakePolicy,
      checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const communicationsPolicy = normalizeCommunicationsPolicy({
      venueName: "Offer fixture hall",
      startsAt,
      endsAt,
      nextSteps: [
        {
          stableKey: "review_portal",
          title: "Review the portal",
          detail: "Check the latest event details before confirming the team's place.",
        },
      ],
      discordUrl: "https://discord.gg/offer-fixture",
      discordLabel: "Open event Discord",
      notificationProvider: "cloudflare_email",
      emailTemplates: defaultParticipantEmailTemplates(),
    });
    const communicationsPolicyId = await ctx.db.insert("communicationsPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...communicationsPolicy,
      checksum: communicationsPolicyChecksum(communicationsPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedCommunicationsPolicyId: communicationsPolicyId,
    });
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: intakePolicyId,
      stage: "review",
      initialIdea: "A quiet, reliable venue coordination tool.",
      version: 1,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A quiet, reliable venue coordination tool.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "offer-fixture-initial",
    });
    const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      ordinal: 1,
      text: "Who uses it first?",
      purposeKey: "user",
      answerLength: "short",
      source: "fallback",
      sourceAnswerVersionIds: [initialAnswerId],
      intakePolicyVersionId: intakePolicyId,
      state: "answered",
      validationCategory: "test_fixture",
      answeredAt: now,
      createdAt: now,
    });
    await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      promptKey: "introduction_follow_up_1",
      generatedQuestionId: questionId,
      answerVersion: 1,
      value: "The floor operations team.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "offer-fixture-follow-up",
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: policyId,
      submittedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A quiet, reliable venue coordination tool.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [
        {
          questionId,
          ordinal: 1,
          question: "Who uses it first?",
          purposeKey: "user",
          answerLength: "short",
          source: "fallback",
          answer: "The floor operations team.",
        },
      ],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicyId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicyId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: policyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    await ctx.db.patch(teamId, { lockedProjectVersionId: projectId });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: policyId,
      state: "accepted",
      decisionStage: "released",
      experienceBand: "mixed_or_external",
      humanDecision: "accept",
      humanReasonCode: "fixture_accept",
      decidedByPersonId: personId,
      decidedAt: now,
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 2,
      submittedAt: now,
    });
    const capacityId = await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId: policyId,
      capacity: 100,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    const [event, application, project, policy, team] = await Promise.all([
      ctx.db.get(eventId),
      ctx.db.get(applicationId),
      ctx.db.get(projectId),
      ctx.db.get(policyId),
      ctx.db.get(teamId),
    ]);
    if (!event || !application || !project || !policy || !team) {
      throw new Error("Offer fixture context did not persist.");
    }
    const creationExpiry = expiresAt > now ? expiresAt : now + 60_000;
    const created = await createAdmissionOffer(ctx, {
      event,
      application,
      project,
      policy,
      team,
      actorPersonId: personId,
      grantIds: [],
      expiresAt: creationExpiry,
      ...(reminderAt !== undefined ? { reminderAt } : {}),
      now,
    });
    if (creationExpiry !== expiresAt) {
      await ctx.db.patch(created.offer._id, { expiresAt });
    }
    const reservation = await ctx.db
      .query("admissionCapacityReservations")
      .withIndex("by_offer", (index) => index.eq("offerId", created.offer._id))
      .unique();
    if (!reservation) throw new Error("Offer capacity reservation did not persist.");
    return {
      eventId,
      personId,
      membershipId,
      teamId,
      teamMemberId,
      lockedRosterSnapshotId,
      projectId,
      applicationId,
      policyId,
      communicationsPolicyId,
      offerId: created.offer._id,
      capacityId,
      reservationId: reservation._id,
    };
  });
}

async function readOfferState(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
) {
  return backend.run(async (ctx) => ({
    application: await ctx.db.get(fixture.applicationId),
    offer: await ctx.db.get(fixture.offerId),
    team: await ctx.db.get(fixture.teamId),
    teamAvailability: await ctx.db
      .query("attendanceTeamAvailability")
      .withIndex("by_event_team", (index) =>
        index.eq("eventId", fixture.eventId).eq("teamId", fixture.teamId),
      )
      .unique(),
    membership: await ctx.db.get(fixture.membershipId),
    reservation: await ctx.db.get(fixture.reservationId),
    capacity: await ctx.db.get(fixture.capacityId),
    deliveries: await ctx.db.query("participantNotificationDeliveries").collect(),
    audits: await ctx.db.query("auditEvents").collect(),
  }));
}

async function updateRosterStatus(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
  onboardingStatus: "submitted" | "offer_pending" | "accepted",
  externalPassCommunicationsPolicyVersionId?: Id<"communicationsPolicyVersions">,
) {
  const application = await backend.run((ctx) => ctx.db.get(fixture.applicationId));
  if (!application) throw new Error("The offer fixture application is missing.");
  await backend.mutation(internal.admissions.updateRosterOnboardingStatus, {
    applicationId: application._id,
    expectedApplicationVersion: application.version,
    lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    onboardingStatus,
    cursor: null,
    ...(externalPassCommunicationsPolicyVersionId !== undefined
      ? { externalPassCommunicationsPolicyVersionId }
      : {}),
  });
}

async function scheduledRosterNotificationCount(backend: BackendTest) {
  return backend.run(async (ctx) =>
    ctx.db.system
      .query("_scheduled_functions")
      .collect()
      .then(
        (jobs) =>
          jobs.filter((job) =>
            job.name.includes("participantNotifications:enqueueRosterBatch"),
          ).length,
      ),
  );
}

async function enqueueRosterNotification(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
  templateKey: "offer" | "offer_confirmed" | "offer_declined" | "offer_expired",
  applicationVersion: number,
) {
  await backend.mutation(internal.participantNotifications.enqueueRosterBatch, {
    eventId: fixture.eventId,
    applicationId: fixture.applicationId,
    teamId: fixture.teamId,
    lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    lockedMemberCount: 1,
    communicationsPolicyVersionId: fixture.communicationsPolicyId,
    templateKey,
    applicationVersion,
    cursor: null,
    processedMemberCount: 0,
  });
}

async function prepareManualRsvp(backend: BackendTest, fixture: Awaited<ReturnType<typeof seedOfferedApplication>>) {
  backend.registerComponent("betterAuth", betterAuthSchema, authModules);
  const now = Date.now();
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "RSVP Operator", email: "rsvp.operator@vitstudent.ac.in",
      emailVerified: true, createdAt: now, updatedAt: now } },
  });
  if (!user || typeof user !== "object" || !("_id" in user) || typeof user._id !== "string") throw new Error("Missing auth user");
  const userId = user._id;
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "session", data: { userId, token: "manual-rsvp-session", expiresAt: now + 86_400_000,
      createdAt: now, updatedAt: now } },
  });
  if (!session || typeof session !== "object" || !("_id" in session) || typeof session._id !== "string") throw new Error("Missing auth session");
  const data = await backend.run(async ctx => {
    const event = await ctx.db.get(fixture.eventId);
    if (!event) throw new Error("Missing event");
    await ctx.db.patch(event._id, { admissionResultsReleasedAt: now - 1000, startsAt: now - 1000,
      status: "registration_closed", endsAt: now + 86_400_000 });
    const personId = await ctx.db.insert("people", { authUserId: userId, verifiedEmail: "rsvp.operator@vitstudent.ac.in",
      displayName: "RSVP Operator", status: "active", createdAt: now, updatedAt: now });
    const subjectId = await ctx.db.insert("eventAccessSubjects", { eventId: fixture.eventId, personId,
      emailNormalized: "rsvp.operator@vitstudent.ac.in", displayName: "RSVP Operator", status: "active",
      linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now });
    const { grantId } = await insertPermissionGrant(ctx, { eventId: fixture.eventId, personId,
      eventAccessSubjectId: subjectId, permissionKey: "application.offer.manage", scopeType: "application",
      scopeId: fixture.applicationId, sourceType: "manual", sourceId: "manual-rsvp-test", reason: "Record a manual RSVP" });
    return { eventSlug: event.slug, personId, grantId };
  });
  return { ...data, client: backend.withIdentity({ subject: userId, sessionId: session._id }) };
}
