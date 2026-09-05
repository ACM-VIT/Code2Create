/// <reference types="vite/client" />
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import {
  classifyVenueLocation,
  validateVenuePolicy,
  venueCallPurpose,
} from "./lib/reviewerVenuePolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
const initialTime = 1_800_000_000_000;
const sendPush = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "code2create-reviewer-push" }],
  cert: vi.fn(),
  initializeApp: vi.fn(),
}));
vi.mock("firebase-admin/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/messaging")>()),
  getMessaging: () => ({ send: sendPush }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  sendPush.mockReset().mockResolvedValue("fixture-message-id");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValue(
        new Error("Provider network calls are disabled in lifecycle tests"),
      ),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function advance(minutes: number) {
  vi.setSystemTime(Date.now() + minutes * 60_000);
}

async function fixture() {
  const backend = convexTest({ schema, modules });
  backend.registerComponent("betterAuth", betterAuthSchema, authModules);
  const user = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Reviewer",
        email: "venue@example.test",
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  const userId = idOf(user);
  const session = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: initialTime + 86_400_000,
        token: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        userId,
      },
    },
  });
  const ids = await backend.run(async (ctx) => {
    const now = Date.now();
    const eventId = await ctx.db.insert("events", {
      slug: "venue-test",
      name: "Venue test",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: [],
      applicationsCloseAt: now - 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: userId,
      googleSubject: "venue-google",
      verifiedEmail: "venue@example.test",
      displayName: "Reviewer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "venue@example.test",
      displayName: "Reviewer",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const grants = [];
    for (const permissionKey of [
      "reviewer.device.register",
      "communications.call_consent.manage",
      "review.configuration.read",
      "review.configuration.publish",
      "reviewer.profile.read",
    ] as const) {
      const self =
        permissionKey === "reviewer.device.register" ||
        permissionKey === "communications.call_consent.manage";
      grants.push(
        await ctx.db.insert("permissionGrants", {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey,
          scopeType: self ? "self" : "event",
          ...(self ? { scopeId: subjectId } : {}),
          status: "active",
          sourceType: "reserve_assignment",
          sourceId: "venue-test",
          validFrom: now - 1000,
          reason: "Venue test",
          createdAt: now,
          activatedAt: now,
        }),
      );
    }
    const profileId = await ctx.db.insert("reviewerProfiles", {
      eventId,
      personId,
      contactPhone: "+919111111111",
      technicalDomains: [],
      productDomains: [],
      languages: ["English"],
      criterionKeys: [],
      seniority: "sc",
      strength: 2,
      trainingStatus: "complete",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const deviceId = await ctx.db.insert("reviewerDevices", {
      eventId,
      personId,
      installationId: "venue-phone",
      name: "Venue phone",
      platform: "android",
      appBuild: 2,
      cameraReady: true,
      encryptedDraftReady: true,
      pushToken: "fixture-token-not-for-delivery",
      pushProvider: "fcm",
      pushEnvironment: "production",
      pushTokenStatus: "active",
      pushTokenUpdatedAt: now,
      status: "active",
      version: 1,
      registeredAt: now,
      lastSeenAt: now,
    });
    const policy = {
      enabled: true,
      name: "Event hall",
      latitude: 12.9692,
      longitude: 79.1559,
      radiusMeters: 200,
      startsAt: now - 60_000,
      endsAt: now + 86_400_000,
      absenceGraceMinutes: 5,
      callDelayMinutes: 10,
      confirmationAgent: {
        appId: "venue-confirmation",
        appVersion: 1,
        responseWindowMinutes: 10,
      },
    };
    const policyId = await ctx.db.insert("reviewerVenuePolicies", {
      eventId,
      ...policy,
      version: 1,
      updatedByPersonId: personId,
      updatedAt: now,
    });
    return {
      eventId,
      personId,
      subjectId,
      deviceId,
      policyId,
      profileId,
      grants,
      policy,
    };
  });
  const reviewer = backend.withIdentity({
    subject: userId,
    sessionId: idOf(session),
  });
  const base = { eventSlug: "venue-test", installationId: "venue-phone" };
  const enabled = await reviewer.mutation(api.reviewerVenue.setMonitoring, {
    ...base,
    enabled: true,
    clientOperationId: "enable-test",
  });
  const sample = (
    where: "inside" | "outside" = "outside",
    extra: { accuracy?: number; sampledAt?: number; mocked?: boolean } = {},
  ) =>
    reviewer.mutation(api.reviewerVenue.reportLocation, {
      ...base,
      generation: enabled.generation,
      latitude:
        where === "inside" ? ids.policy.latitude : ids.policy.latitude + 0.01,
      longitude: ids.policy.longitude,
      accuracy: 10,
      sampledAt: Date.now(),
      ...extra,
    });
  const mine = () => reviewer.query(api.reviewerVenue.mine, base);
  const dwell = async () => {
    await sample();
    for (let index = 0; index < 5; index += 1) {
      advance(1);
      await sample();
    }
    const state = await mine();
    if (!state.departure) throw new Error("Expected a confirmed departure");
    return state.departure._id;
  };
  const notify = async () => {
    const departureId = await dwell();
    await backend.action(internal.reviewPush.deliverVenueReminder, {
      departureId,
    });
    expect(sendPush).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          body: expect.stringContaining("Event hall"),
        }),
        data: expect.objectContaining({
          kind: "reviewer_venue_absence",
          url: "/venue",
        }),
      }),
    );
    return departureId;
  };
  const grantCall = () =>
    reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, {
      eventSlug: base.eventSlug,
      purpose: venueCallPurpose,
      state: "granted",
      destinationPhone: "+919111111111",
      expectedVersion: 0,
      clientOperationId: "consent-test",
    });
  const calls = () =>
    backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect());
  const waitForCall = async () => {
    for (let index = 0; index < 10; index += 1) {
      advance(1);
      await sample();
      await backend.mutation(internal.reviewerVenueEscalation.sweep, {});
    }
  };
  return {
    backend,
    reviewer,
    base,
    ids,
    sample,
    mine,
    dwell,
    notify,
    grantCall,
    calls,
    waitForCall,
    enabled,
  };
}

describe("reviewer venue lifecycle", () => {
  test("rejects a pre-generation GPS fix even when labelled with the current generation", async () => {
    const f = await fixture();
    const oldSampledAt = Date.now();
    advance(1);
    const next = await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
      ...f.base,
      enabled: true,
      clientOperationId: "enable-new-generation",
    });
    expect(next.startedAt).toBe(Date.now());
    const result = await f.reviewer.mutation(api.reviewerVenue.reportLocation, {
      ...f.base,
      generation: next.generation,
      sampledAt: oldSampledAt,
      latitude: f.ids.policy.latitude,
      longitude: f.ids.policy.longitude,
      accuracy: 10,
    });
    expect(result).toEqual({ accepted: false, active: true });
    expect((await f.mine()).presence?.sampledAt).toBeUndefined();
    expect(
      await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
        ...f.base,
        enabled: true,
        clientOperationId: "enable-new-generation",
      }),
    ).toEqual(next);
  });

  test("a report after venue settings change stays visible without renewing old tracking", async () => {
    const f = await fixture();
    await f.backend.run((ctx) => ctx.db.patch(f.ids.policyId, { version: 2 }));
    await f.reviewer.mutation(api.reviewerVenue.declareDeparture, {
      ...f.base,
      reason: "Leaving after setup changed",
      clientOperationId: "report-new-policy",
    });
    expect((await f.mine()).presence).toMatchObject({
      policyVersion: 2,
      trackingGeneration: 2,
      status: "reported_left",
      monitoringEnabled: false,
    });
    expect(await f.sample()).toMatchObject({ active: false });
    const roster = await f.reviewer.query(api.reviewerVenueOperations.roster, {
      eventSlug: f.base.eventSlug,
      paginationOpts: { numItems: 40, cursor: null },
    });
    expect(roster.page[0]?.status).toBe("reported_left");
  });

  test("departure reporting works without location permission and remains off duty when location changes", async () => {
    const f = await fixture();
    await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
      ...f.base,
      enabled: false,
      expectedGeneration: 1,
      clientOperationId: "off-for-break",
    });
    await f.reviewer.mutation(api.reviewerVenue.declareDeparture, {
      ...f.base,
      reason: "Meal break",
      clientOperationId: "leave-without-location",
    });
    const reported = await f.mine();
    expect(reported.presence).toMatchObject({
      status: "reported_left",
      monitoringEnabled: false,
    });
    const enabled = await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
      ...f.base,
      enabled: true,
      clientOperationId: "check-return",
    });
    await f.reviewer.mutation(api.reviewerVenue.reportLocation, {
      ...f.base,
      generation: enabled.generation,
      latitude: f.ids.policy.latitude,
      longitude: f.ids.policy.longitude,
      accuracy: 10,
      sampledAt: Date.now(),
    });
    await f.backend.run((ctx) => ctx.db.patch(f.ids.policyId, { version: 2 }));
    expect((await f.mine()).presence?.status).toBe("reported_left");
  });

  test("confirms sustained outside evidence once, then resolves on return without storing coordinates", async () => {
    const f = await fixture();
    await f.sample("inside");
    expect((await f.mine()).presence?.status).toBe("inside");
    advance(1);
    const departureId = await f.dwell();
    expect((await f.mine()).presence?.status).toBe("left");
    advance(1);
    await f.sample();
    expect((await f.mine()).departure?._id).toBe(departureId);
    advance(1);
    await f.sample("inside");
    expect((await f.mine()).presence).toMatchObject({ status: "inside" });
    const row = await f.backend.run((ctx) => ctx.db.get(departureId));
    expect(row?.state).toBe("returned");
    expect((await f.mine()).presence).not.toHaveProperty("latitude");
    expect(
      await f.backend.mutation(
        internal.reviewerVenueEscalation.claimNotification,
        { departureId, attemptId: "late" },
      ),
    ).toBeNull();
  });

  test("GPS uncertainty, boundary jitter, mocked fixes and stale readings do not prove a departure", async () => {
    const f = await fixture();
    await f.sample();
    advance(2);
    await f.sample();
    advance(1);
    await f.sample("outside", { accuracy: 500 });
    expect((await f.mine()).presence?.status).toBe("unknown");
    advance(1);
    await f.sample();
    advance(2);
    await f.sample();
    expect((await f.mine()).presence?.status).toBe("outside");
    advance(1);
    await f.sample("outside", { mocked: true });
    expect((await f.mine()).presence?.status).toBe("unknown");
    expect(
      await f.sample("outside", { sampledAt: Date.now() - 180_000 }),
    ).toMatchObject({ accepted: false });
    expect((await f.mine()).departure).toBeNull();
  });

  test("missing GPS becomes unknown and never triggers a call or an automatic departure", async () => {
    const f = await fixture();
    await f.sample();
    advance(6);
    await f.backend.mutation(internal.reviewerVenueEscalation.sweep, {});
    expect((await f.mine()).presence?.status).toBe("unknown");
    expect((await f.mine()).departure).toBeNull();
    expect(await f.calls()).toEqual([]);
  });

  test("a declared departure is idempotent and GPS cannot put a reviewer back on duty", async () => {
    const f = await fixture();
    const args = {
      ...f.base,
      reason: "Taking a meal break",
      clientOperationId: "leave-test",
    };
    await f.reviewer.mutation(api.reviewerVenue.declareDeparture, args);
    await f.reviewer.mutation(api.reviewerVenue.declareDeparture, args);
    const departureId = (await f.mine()).departure?._id;
    if (!departureId) throw new Error("Departure missing");
    await f.sample();
    advance(6);
    await f.sample();
    expect((await f.mine()).presence?.status).toBe("reported_left");
    advance(1);
    await f.sample("inside");
    expect((await f.mine()).presence?.status).toBe("reported_left");
    expect(await f.calls()).toHaveLength(0);
    expect(
      await f.backend.run((ctx) =>
        ctx.db.query("reviewerVenueDepartures").collect(),
      ),
    ).toHaveLength(1);
  });

  test("notifies first, waits the configured delay, and enqueues exactly one consented call", async () => {
    const f = await fixture();
    await f.grantCall();
    await f.notify();
    expect(await f.calls()).toHaveLength(0);
    await f.waitForCall();
    await f.backend.mutation(internal.reviewerVenueEscalation.sweep, {});
    const calls = await f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      state: "pending",
      purpose: venueCallPurpose,
      sourceType: "reviewer_venue_departure",
    });
    const call = calls[0];
    if (!call) throw new Error("Call missing");
    vi.stubEnv("OUTBOUND_CALL_WORKER_URL", "https://voice.example.test");
    vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.test");
    vi.stubEnv(
      "OUTBOUND_CALL_REQUEST_SECRET",
      "test-only-venue-call-signing-secret-32-bytes",
    );
    const sendCall = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, deliveryId: call._id }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", sendCall);
    await f.backend.action(internal.outboundCalls.deliver, {
      deliveryId: call._id,
    });
    expect(sendCall).toHaveBeenCalledOnce();
    expect(sendCall).toHaveBeenCalledWith(
      new URL("https://voice.example.test/v1/calls"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          "Your phone suggests you may be outside Event hall",
        ),
      }),
    );
    expect((await f.calls())[0]?.state).toBe("provider_accepted");
  });

  test("notification failures retry and duplicate delivery is ignored", async () => {
    const f = await fixture();
    await f.grantCall();
    const departureId = await f.dwell();
    sendPush.mockRejectedValueOnce(new Error("Provider unavailable"));
    await f.backend.action(internal.reviewPush.deliverVenueReminder, {
      departureId,
    });
    expect((await f.mine()).departure).toMatchObject({
      notificationState: "failed",
    });
    expect((await f.mine()).departure?.notifiedAt).toBeUndefined();
    expect(await f.calls()).toEqual([]);
    await f.backend.action(internal.reviewPush.deliverVenueReminder, {
      departureId,
    });
    await f.backend.action(internal.reviewPush.deliverVenueReminder, {
      departureId,
    });
    expect(sendPush).toHaveBeenCalledTimes(2);
    expect((await f.mine()).departure).toMatchObject({
      notificationState: "sent",
      notificationAttempts: 2,
    });
  });

  test("unavailable push still falls back to a consented call after the reminder delay", async () => {
    const f = await fixture();
    await f.grantCall();
    await f.backend.run((ctx) =>
      ctx.db.patch(f.ids.deviceId, { pushTokenStatus: "not_registered" }),
    );
    const departureId = await f.dwell();
    await f.backend.action(internal.reviewPush.deliverVenueReminder, {
      departureId,
    });
    expect(sendPush).not.toHaveBeenCalled();
    expect((await f.mine()).departure).toMatchObject({
      notificationState: "unavailable",
    });
    await f.waitForCall();
    expect((await f.calls())[0]?.state).toBe("pending");
  });

  test("a visible in-app warning starts the reminder timer without a push claim", async () => {
    const f = await fixture();
    const departureId = await f.dwell();
    await f.reviewer.mutation(api.reviewerVenueWarning.acknowledgeWarning, {
      eventSlug: f.base.eventSlug,
      departureId,
    });
    expect((await f.mine()).departure).toMatchObject({
      notifiedAt: Date.now(),
      reminderStartedAt: Date.now(),
    });
  });

  test.each([
    "return",
    "report",
    "stop",
    "revoke",
    "stale",
    "event_end",
    "policy_change",
    "device_revoked",
    "grant_revoked",
  ] as const)("cancels a queued call after %s", async (change) => {
    const f = await fixture();
    const consent = await f.grantCall();
    await f.notify();
    await f.waitForCall();
    const call = (await f.calls())[0];
    if (!call) throw new Error("Call missing");
    if (change === "return") {
      advance(0.1);
      await f.sample("inside");
    }
    if (change === "report")
      await f.reviewer.mutation(api.reviewerVenue.declareDeparture, {
        ...f.base,
        reason: "Leaving for the day",
        clientOperationId: "late-report",
      });
    if (change === "stop")
      await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
        ...f.base,
        enabled: false,
        expectedGeneration: 1,
        clientOperationId: "stop",
      });
    if (change === "revoke")
      await f.reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, {
        eventSlug: f.base.eventSlug,
        purpose: venueCallPurpose,
        state: "revoked",
        expectedVersion: consent.version,
        clientOperationId: "revoke",
      });
    if (change === "stale") advance(4);
    if (change === "event_end")
      await f.backend.run((ctx) =>
        ctx.db.patch(f.ids.policyId, { endsAt: Date.now() }),
      );
    if (change === "policy_change")
      await f.backend.run((ctx) =>
        ctx.db.patch(f.ids.policyId, { version: 2 }),
      );
    if (change === "device_revoked")
      await f.backend.run((ctx) =>
        ctx.db.patch(f.ids.deviceId, { status: "revoked" }),
      );
    if (change === "grant_revoked")
      await f.backend.run(async (ctx) => {
        for (const grant of f.ids.grants)
          await ctx.db.patch(grant, { status: "revoked" });
      });
    expect(
      await f.backend.mutation(internal.outboundCallState.claimDelivery, {
        deliveryId: call._id,
        attemptId: "stale-call",
      }),
    ).toBeNull();
    expect((await f.calls())[0]?.state).toBe("cancelled");
  });

  test("call consent is purpose-specific and missing consent is visible as unavailable", async () => {
    const f = await fixture();
    await f.reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, {
      eventSlug: f.base.eventSlug,
      state: "granted",
      destinationPhone: "+919111111111",
      expectedVersion: 0,
      clientOperationId: "page-consent",
    });
    await f.notify();
    await f.waitForCall();
    expect((await f.calls())[0]).toMatchObject({
      state: "unavailable",
      providerErrorCode: "call_consent_not_granted",
    });
    expect(
      await f.reviewer.query(api.outboundCallConsents.mine, {
        eventSlug: f.base.eventSlug,
        purpose: venueCallPurpose,
      }),
    ).toMatchObject({ state: "not_configured" });
  });

  test("old tracking generations, foreign devices and unprivileged roster reads are rejected", async () => {
    const f = await fixture();
    await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
      ...f.base,
      enabled: false,
      expectedGeneration: 1,
      clientOperationId: "off",
    });
    await f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
      ...f.base,
      enabled: true,
      clientOperationId: "new-session",
    });
    expect(await f.sample()).toMatchObject({ accepted: false, active: false });
    await expect(
      f.reviewer.mutation(api.reviewerVenue.setMonitoring, {
        ...f.base,
        enabled: false,
        expectedGeneration: 1,
        clientOperationId: "delayed-off",
      }),
    ).rejects.toThrow("Venue checks changed");
    expect((await f.mine()).presence?.monitoringEnabled).toBe(true);
    await expect(
      f.reviewer.mutation(api.reviewerVenue.reportLocation, {
        ...f.base,
        installationId: "another-phone",
        generation: 1,
        latitude: 0,
        longitude: 0,
        accuracy: 10,
        sampledAt: Date.now(),
      }),
    ).rejects.toThrow("Register this phone");
    await expect(
      f.backend.query(api.reviewerVenueOperations.roster, {
        eventSlug: f.base.eventSlug,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow();
    const roster = await f.reviewer.query(api.reviewerVenueOperations.roster, {
      eventSlug: f.base.eventSlug,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(roster.page).toHaveLength(1);
  });

  test("policy changes use permissions, optimistic concurrency and idempotency", async () => {
    const f = await fixture();
    const args = {
      eventSlug: f.base.eventSlug,
      policy: { ...f.ids.policy, radiusMeters: 300 },
      expectedVersion: 1,
      clientOperationId: "policy-save",
    };
    expect(
      await f.reviewer.mutation(api.reviewerVenueOperations.configure, args),
    ).toEqual({ version: 2 });
    expect(
      await f.reviewer.mutation(api.reviewerVenueOperations.configure, args),
    ).toEqual({ version: 2 });
    await expect(
      f.reviewer.mutation(api.reviewerVenueOperations.configure, {
        ...args,
        clientOperationId: "outdated",
      }),
    ).rejects.toThrow("Venue settings changed");
    await expect(
      f.reviewer.mutation(api.reviewerVenueOperations.configure, {
        ...args,
        expectedVersion: 2,
        clientOperationId: "invalid",
        policy: { ...args.policy, latitude: Number.NaN },
      }),
    ).rejects.toThrow();
    expect(await f.sample()).toMatchObject({ active: false });
  });
});

describe("venue location classification", () => {
  const policy = { latitude: 0, longitude: 0, radiusMeters: 200 };
  test("requires the accuracy circle to be inside or clearly outside the boundary", () => {
    expect(
      classifyVenueLocation(policy, {
        latitude: 0,
        longitude: 0,
        accuracy: 10,
      }),
    ).toBe("inside");
    expect(
      classifyVenueLocation(policy, {
        latitude: 0.0018,
        longitude: 0,
        accuracy: 30,
      }),
    ).toBe("uncertain");
    expect(
      classifyVenueLocation(policy, {
        latitude: 0.01,
        longitude: 0,
        accuracy: 10,
      }),
    ).toBe("outside");
    expect(() =>
      classifyVenueLocation(policy, {
        latitude: Infinity,
        longitude: 0,
        accuracy: 10,
      }),
    ).toThrow();
    expect(() =>
      validateVenuePolicy({
        ...policy,
        enabled: true,
        name: "Venue",
        startsAt: 0,
        endsAt: 1000,
        absenceGraceMinutes: 0,
        callDelayMinutes: -1,
      }),
    ).toThrow();
  });
});

function idOf(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("_id" in value) ||
    typeof value._id !== "string"
  )
    throw new Error("Missing fixture ID");
  return value._id;
}

describe("venue voice responses", () => {
  const response = {
    outcome: "away" as const,
    confirmed: true,
    summary: "Away for 15 minutes",
    returnInMinutes: 15,
    transcript: [
      {
        role: "agent" as const,
        text: "You are unavailable for fifteen minutes, correct?",
      },
      { role: "user" as const, text: "Yes, that's correct." },
    ],
  };
  const { transcript: _transcript, ...responseSummary } = response;
  async function confirmation() {
    const f = await fixture();
    await f.grantCall();
    await f.notify();
    await f.waitForCall();
    const call = (await f.calls())[0];
    if (!call) throw new Error("Missing confirmation call");
    await f.backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: call._id,
      attemptId: "voice-test",
    });
    const event = {
      providerEventId: crypto.randomUUID(),
      deliveryId: call._id,
      eventType: "call.completed" as const,
      providerAt: Date.now(),
      providerCallId: "sarvam-attempt",
      venueResponse: response,
    };
    return { ...f, call, event };
  }
  test("a confirmed absence is applied once; altered replays are rejected", async () => {
    const f = await confirmation();
    await f.backend.mutation(
      internal.outboundCallState.recordProviderEvent,
      f.event,
    );
    const first = (await f.calls())[0];
    expect(first).toMatchObject({
      state: "completed",
      venueResponseEffect: "clocked_out",
      venueResponse: responseSummary,
    });
    expect((await f.mine()).presence?.status).toBe("reported_left");
    expect(await f.reviewer.query(api.reviewerVenueOperations.callResponse, { eventSlug: f.base.eventSlug, deliveryId: f.call._id })).toEqual(response);
    expect(first?.venueResponse).not.toHaveProperty("transcript");
    await f.backend.mutation(
      internal.outboundCallState.recordProviderEvent,
      f.event,
    );
    expect((await f.calls())[0]?.version).toBe(first?.version);
    await expect(
      f.backend.mutation(internal.outboundCallState.recordProviderEvent, {
        ...f.event,
        venueResponse: { ...response, outcome: "available" },
      }),
    ).rejects.toThrow("reused with different data");
  });
  test.each(["expired", "revoked", "returned", "policy_changed"] as const)(
    "a %s confirmation stays in history without changing duty",
    async (change) => {
      const f = await confirmation();
      if (change === "expired") advance(11);
      if (change === "returned") {
        advance(1);
        await f.sample("inside");
      }
      const consentId = f.call.consentId;
      if (change === "revoked" && consentId)
        await f.backend.run((ctx) =>
          ctx.db.patch(consentId, { state: "revoked", version: 2 }),
        );
      if (change === "policy_changed")
        await f.backend.run((ctx) =>
          ctx.db.patch(f.ids.policyId, { version: 2 }),
        );
      await f.backend.mutation(
        internal.outboundCallState.recordProviderEvent,
        f.event,
      );
      expect((await f.calls())[0]).toMatchObject({
        state: "completed",
        venueResponseEffect: "stale",
        venueResponse: responseSummary,
      });
      expect((await f.mine()).presence?.status).not.toBe("reported_left");
    },
  );
  test.each(["available", "unclear", "needs_help"] as const)(
    "records %s separately from phone GPS",
    async (outcome) => {
      const f = await confirmation();
      await f.backend.mutation(internal.outboundCallState.recordProviderEvent, {
        ...f.event,
        venueResponse: {
          ...response,
          outcome,
          confirmed: outcome !== "unclear",
        },
      });
      expect((await f.calls())[0]?.venueResponseEffect).toBe(
        outcome === "available" ? "confirmed" : "needs_ops",
      );
      expect((await f.mine()).presence?.status).toBe("left");
    },
  );
  test("answered call with no structured response is never confirmed", async () => {
    const f = await confirmation();
    const { venueResponse: _response, ...event } = f.event;
    await f.backend.mutation(
      internal.outboundCallState.recordProviderEvent,
      event,
    );
    expect((await f.calls())[0]?.venueResponseEffect).toBeUndefined();
    expect((await f.mine()).presence?.status).toBe("left");
  });
});
