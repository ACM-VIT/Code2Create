import type { AttendanceMovementReason } from "@code2create/domain";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema.ts";
import { applyOutingScan, outingPolicy, outingRequest } from "./lib/participantServiceQueue";
import { insertPermissionGrant } from "./lib/permissions";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

function seededBackend(documentsRead?: number) {
  const options = documentsRead === undefined
    ? { schema, modules }
    : { schema, modules, transactionLimits: { documentsRead } };
  const backend = convexTest(options);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "participantServiceQueues");
  return backend;
}

async function createParticipant(
  backend: BackendTest,
  eventId: Id<"events">,
  key: string,
  now: number,
  eligibilityStatus: Doc<"eventMemberships">["eligibilityStatus"] = "eligible",
) {
  const email = `${key}-${crypto.randomUUID()}@example.test`;
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `${key} participant`,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  const authSessionId = documentId(session, "Better Auth session");
  const participant = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google:${authUserId}`,
      verifiedEmail: email,
      displayName: `${key} participant`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: `${key} participant`,
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
      participantClass: "external_participant",
      eligibilityStatus,
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("attendanceVenueStates", {
      eventId, membershipId, state: "inside", version: 1, updatedAt: now,
    });
    return { membershipId, personId, subjectId };
  });
  return { identity: { subject: authUserId, sessionId: authSessionId }, ...participant };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid ID.`);
  }
  return id;
}

async function fixture(capacity = 15, documentsRead?: number) {
  const backend = seededBackend(documentsRead);
  const now = Date.now();
  const eventSlug = `outings-${crypto.randomUUID()}`;
  const eventId = await backend.run((ctx) => ctx.db.insert("events", {
    slug: eventSlug, name: "Outing fixture", timezone: "Asia/Kolkata", status: "live",
    vitEmailDomains: ["vitstudent.ac.in"], startsAt: now - 60_000, endsAt: now + 3 * 3_600_000,
    applicationsCloseAt: now - 60_000, version: 1, createdAt: now, updatedAt: now,
  }));
  const operator = await createParticipant(backend, eventId, "operator", now);
  await backend.run((ctx) => insertPermissionGrant(ctx, {
    eventId, eventAccessSubjectId: operator.subjectId, personId: operator.personId,
    permissionKey: "configuration.manage", scopeType: "event",
    sourceType: "manual", sourceId: "outing-fixture", grantedByPersonId: operator.personId, reason: "Configure fixture outings",
  }));
  const zoneId = await backend.run(async (ctx) => {
    const planVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId, version: 1, name: "Test plan", vitBarcodeSymbologies: ["code128"],
      vitBarcodeNormalizationVersion: "trim-v1", offlineQueueMaxScans: 25, offlineQueueMaxAgeSeconds: 300,
      status: "published", checksum: "test", createdByPersonId: operator.personId, createdAt: now,
    });
    return ctx.db.insert("attendanceZones", { eventId, planVersionId, stableKey: "main", name: "Main", createdAt: now });
  });
  const ops = backend.withIdentity(operator.identity);
  if (capacity > 0) await ops.mutation(api.serviceQueues.configure, { eventSlug, capacity, expectedVersion: 0, clientOperationId: "configure" });
  const makePerson = async (key: string) => {
    const person = await createParticipant(backend, eventId, key, now);
    const client = backend.withIdentity(person.identity);
    return {
      ...person, client,
      savePhone: (phone = "+919876543210") => backend.run((ctx) => ctx.db.insert("participantProfiles", {
        eventId, membershipId: person.membershipId, participantClass: "external_participant",
        fullName: `${key} participant`, phone, gender: "male", institution: "Fixture college",
        yearOfStudy: "first", profileVersion: 1, updatedAt: now,
      })),
      request: (clientOperationId: string = crypto.randomUUID()) => client.mutation(api.serviceQueues.join, { eventSlug, kind: "outing_permission", clientOperationId }),
      current: async () => (await client.query(api.serviceQueues.current, { eventSlug }))[0]!,
      scan: (transition: "venue_entry" | "venue_exit", isOfflineReplay = false, movementReason: AttendanceMovementReason = "short_break") => backend.run(async (ctx) => {
        const now = Date.now();
        const result = await applyOutingScan(ctx, { eventId, membershipId: person.membershipId,
          transition, movementReason, isOfflineReplay, now });
        if (result.allowed && result.outing?.status === "out" && transition === "venue_exit") {
          await ctx.db.insert("attendancePresenceEvents", {
            eventId, membershipId: person.membershipId, zoneId, sourceKind: "scanner",
            operatorPersonId: operator.personId, credentialKind: "vit_id_barcode", movementReason,
            transition, outcome: "accepted", outing: result.outing, capturedAt: now, receivedAt: now,
            clientOperationId: crypto.randomUUID(), requestFingerprint: "fixture", isOfflineReplay,
            reasonCode: "venue_exit_recorded",
          });
        }
        return result;
      }),
    };
  };
  return { backend, eventId, eventSlug, now, ops, makePerson };
}

describe("capacity-managed outings", () => {
  test("simultaneous requests for the last slot cannot overbook capacity", async () => {
    const f = await fixture(1);
    const first = await f.makePerson("first"); const second = await f.makePerson("second");
    await Promise.all([first.request(), second.request()]);
    const states = await Promise.all([first.current(), second.current()]);
    expect(states.map((state) => state.status).sort()).toEqual(["permitted", "waiting"]);
    expect(states.every((state) => state.occupiedCount === 1 && state.waitingCount === 1)).toBe(true);
  });

  test("the first 15 requests receive permission and only the 16th waits", async () => {
    const f = await fixture();
    for (let index = 0; index < 15; index += 1) {
      const person = await f.makePerson(`person-${index}`);
      await person.request();
      expect(await person.current()).toMatchObject({ status: "permitted", position: null, waitingCount: 0, occupiedCount: index + 1 });
    }
    const sixteenth = await f.makePerson("sixteenth");
    await sixteenth.request();
    expect(await sixteenth.current()).toMatchObject({ status: "waiting", position: 1, waitingCount: 1, occupiedCount: 15 });
    expect(await sixteenth.scan("venue_exit")).toMatchObject({ allowed: false, outing: { status: "waiting", position: 1 } });
  });

  test("canceling a reservation promotes the oldest waiter and stale retries cannot cancel a new request", async () => {
    const f = await fixture(1);
    const first = await f.makePerson("first");
    const second = await f.makePerson("second");
    const third = await f.makePerson("third");
    await first.request("original-join"); await second.request(); await third.request();
    const original = await first.current();
    const cancel = { eventSlug: f.eventSlug, requestId: original.requestId!, clientOperationId: "cancel" };
    await first.client.mutation(api.serviceQueues.leave, cancel);
    expect(await second.current()).toMatchObject({ status: "permitted", position: null });
    expect(await third.current()).toMatchObject({ status: "waiting", position: 1, occupiedCount: 1 });
    await first.request("original-join");
    expect(await first.current()).toMatchObject({ status: "available", requestId: null });
    await first.request("new-join");
    await first.client.mutation(api.serviceQueues.leave, cancel);
    expect(await first.current()).toMatchObject({ status: "waiting", position: 2 });
    await expect(first.client.mutation(api.serviceQueues.leave, { ...cancel, clientOperationId: "stale-cancel" })).rejects.toThrow("already changed");
  });

  test("departure starts 15 minutes, overdue outings retain capacity, and only the return releases it", async () => {
    const f = await fixture(1);
    const first = await f.makePerson("first"); const second = await f.makePerson("second");
    await first.request(); await second.request();
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.now + 120_000);
    const departure = await first.scan("venue_exit");
    expect(departure).toMatchObject({ allowed: true, outing: { status: "out", returnBy: f.now + 1_020_000 } });
    const entry = await first.current();
    expect(entry).toMatchObject({ status: "out", position: null, occupiedCount: 1 });
    await expect(first.client.mutation(api.serviceQueues.leave, { eventSlug: f.eventSlug, requestId: entry.requestId!, clientOperationId: "cancel-out" })).rejects.toThrow("scanned on return");
    clock.mockReturnValue(f.now + 1_020_001);
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: entry.requestId! });
    expect(await first.current()).toMatchObject({ status: "overdue", occupiedCount: 1 });
    expect(await second.current()).toMatchObject({ status: "waiting" });
    expect(await first.scan("venue_entry")).toMatchObject({ allowed: true, outing: { status: "returned" } });
    expect(await second.current()).toMatchObject({ status: "permitted", occupiedCount: 1, waitingCount: 0 });
    await first.scan("venue_entry");
    expect(await second.current()).toMatchObject({ occupiedCount: 1 });
  });

  test("unused permission expires and its scheduled callback cannot expire a later request", async () => {
    const f = await fixture(1);
    const first = await f.makePerson("first"); const second = await f.makePerson("second");
    await first.request(); await second.request();
    const original = await first.current();
    const clock = vi.spyOn(Date, "now").mockReturnValue(original.permissionExpiresAt!);
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: original.requestId! });
    expect(await first.current()).toMatchObject({ status: "expired" });
    expect(await second.current()).toMatchObject({ status: "permitted", occupiedCount: 1 });
    await first.request();
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: original.requestId! });
    expect(await first.current()).toMatchObject({ status: "waiting", position: 1 });
    clock.mockReturnValue((await second.current()).permissionExpiresAt!);
    expect(await second.scan("venue_exit")).toMatchObject({ allowed: false, outing: { status: "expired" } });
    expect(await first.current()).toMatchObject({ status: "permitted", occupiedCount: 1 });
  });

  test("capacity edits are authorized, versioned, idempotent and preserve granted permissions when reduced", async () => {
    const f = await fixture(2);
    const first = await f.makePerson("first"); const second = await f.makePerson("second"); const third = await f.makePerson("third");
    await first.request(); await second.request(); await third.request();
    const args = { eventSlug: f.eventSlug, capacity: 1, expectedVersion: 1, clientOperationId: "reduce" };
    await expect(first.client.mutation(api.serviceQueues.configure, args)).rejects.toThrow("permission");
    await f.ops.mutation(api.serviceQueues.configure, args);
    await f.ops.mutation(api.serviceQueues.configure, args);
    expect(await f.ops.query(api.serviceQueues.configuration, { eventSlug: f.eventSlug })).toMatchObject({ capacity: 1, occupiedCount: 2, waitingCount: 1, version: 2 });
    expect(await first.current()).toMatchObject({ status: "permitted" });
    await expect(f.ops.mutation(api.serviceQueues.configure, { ...args, clientOperationId: "stale" })).rejects.toThrow("changed");
    await f.ops.mutation(api.serviceQueues.configure, { ...args, capacity: 3, expectedVersion: 2, clientOperationId: "increase" });
    expect(await third.current()).toMatchObject({ status: "permitted", occupiedCount: 3, waitingCount: 0 });
    expect(await f.backend.run((ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(3);
  });

  test.each([0, -1, 1.5, 1001, Number.NaN])("rejects invalid capacity %s", async (capacity) => {
    const f = await fixture();
    await expect(f.ops.mutation(api.serviceQueues.configure, { eventSlug: f.eventSlug, capacity, expectedVersion: 1, clientOperationId: "invalid" })).rejects.toThrow("whole number");
  });

  test("requires setup, accepted eligibility and actual on-site presence", async () => {
    const f = await fixture(0);
    const person = await f.makePerson("person");
    await expect(person.request()).rejects.toThrow("configured");
    await f.ops.mutation(api.serviceQueues.configure, { eventSlug: f.eventSlug, capacity: 1, expectedVersion: 0, clientOperationId: "setup" });
    for (const eligibilityStatus of ["rejected", "suspended"] as const) {
      await f.backend.run((ctx) => ctx.db.patch(person.membershipId, { eligibilityStatus }));
      await expect(person.request()).rejects.toThrow();
    }
    await f.backend.run(async (ctx) => {
      await ctx.db.patch(person.membershipId, { eligibilityStatus: "eligible", onboardingStatus: "submitted" });
    });
    await expect(person.request()).rejects.toThrow("confirmed participants");
    await f.backend.run(async (ctx) => {
      await ctx.db.patch(person.membershipId, { onboardingStatus: "accepted" });
      const venue = await ctx.db.query("attendanceVenueStates").withIndex("by_event_membership", (q) => q.eq("eventId", f.eventId).eq("membershipId", person.membershipId)).unique();
      await ctx.db.patch(venue!._id, { state: "temporarily_out" });
    });
    await expect(person.request()).rejects.toThrow("return scanned");
    expect(await person.current()).toMatchObject({ status: "offsite", canRequest: false });
  });

  test("a waiter who loses eligibility is skipped when capacity becomes available", async () => {
    const f = await fixture(1);
    const first = await f.makePerson("first"); const second = await f.makePerson("second"); const third = await f.makePerson("third");
    await first.request(); await second.request(); await third.request();
    await f.backend.run((ctx) => ctx.db.patch(second.membershipId, { eligibilityStatus: "suspended" }));
    const request = await first.current();
    await first.client.mutation(api.serviceQueues.leave, { eventSlug: f.eventSlug, requestId: request.requestId!, clientOperationId: "cancel" });
    expect(await third.current()).toMatchObject({ status: "permitted", occupiedCount: 1, waitingCount: 0 });
  });

  test("offline departures never consume permission, but a replayed return releases an occupied slot", async () => {
    const f = await fixture(1);
    const person = await f.makePerson("person"); await person.request();
    expect(await person.scan("venue_exit", true)).toMatchObject({ allowed: false, outing: { status: "online_required" } });
    expect(await person.current()).toMatchObject({ status: "permitted" });
    await person.scan("venue_exit");
    expect(await person.scan("venue_entry", true)).toMatchObject({ allowed: true, outing: { status: "returned" } });
    expect(await f.backend.run((ctx) => outingPolicy(ctx, f.eventId))).toMatchObject({ occupiedCount: 0 });
  });

  test("the event schedule gates requests even before the live label is changed", async () => {
    const f = await fixture(); const person = await f.makePerson("person");
    await f.backend.run((ctx) => ctx.db.patch(f.eventId, { status: "registration_closed" }));
    await person.request();
    expect(await person.current()).toMatchObject({ status: "permitted" });
    await f.backend.run((ctx) => ctx.db.patch(f.eventId, { endsAt: f.now - 1 }));
    await expect(person.request()).rejects.toThrow("while the event is live");
    await f.backend.run((ctx) => ctx.db.patch(f.eventId, { status: "complete" }));
    expect(await person.client.query(api.serviceQueues.current, { eventSlug: f.eventSlug })).toEqual([]);
  });

  test("queue rank and count stay bounded with 80 waiting participants", async () => {
    const f = await fixture(1, 64);
    const holder = await f.makePerson("holder"); await holder.request();
    let last = holder;
    for (let index = 0; index < 80; index += 1) { last = await f.makePerson(`waiter-${index}`); await last.request(); }
    expect(await last.current()).toMatchObject({ status: "waiting", position: 80, waitingCount: 80, occupiedCount: 1 });
    expect(await f.backend.run((ctx) => outingRequest(ctx, last.membershipId))).toMatchObject({ phase: { status: "waiting" } });
  });
});

async function overdueCallFixture(phone: string | null = "+919876543210") {
  const f = await fixture(1);
  const person = await f.makePerson("overdue-caller");
  const profileId = phone === null ? null : await person.savePhone(phone);
  await person.request();
  await person.scan("venue_exit");
  const request = await person.current();
  const clock = vi.spyOn(Date, "now").mockReturnValue(request.returnBy!);
  const advance = () => f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: request.requestId! });
  const calls = () => f.backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect());
  const sweep = () => f.backend.mutation(internal.serviceQueues.sweepOverdueCalls, { cursor: null });
  return { ...f, person, profileId, request, clock, advance, calls, sweep };
}

describe("overdue outing calls", () => {
  test.each([undefined, "meal", "organizer_task", "other", "general"] as const)(
    "does not call when departure reason is %s", async (movementReason) => {
      const f = await overdueCallFixture();
      await f.backend.run(async (ctx) => {
        const scan = await ctx.db.query("attendancePresenceEvents").first();
        if (!scan) throw new Error("Missing departure fixture");
        await ctx.db.patch(scan._id, { movementReason });
      });
      await f.advance(); await f.sweep();
      expect(await f.calls()).toEqual([]);
    },
  );
  test.each(["meal", "organizer_task", "other"] as const)(
    "%s departures create no timed outing or overdue reminder", async (reason) => {
      const f = await fixture(0); const person = await f.makePerson("meal");
      expect(await person.scan("venue_exit", false, reason)).toEqual({ allowed: true, outing: null });
      const clock = vi.spyOn(Date, "now").mockReturnValue(f.now + 2 * 3_600_000);
      await f.backend.mutation(internal.serviceQueues.sweepOverdueCalls, { cursor: null });
      expect(await f.backend.run((ctx) => ctx.db.query("participantServiceQueueEntries").collect())).toEqual([]);
      expect(await f.backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect())).toEqual([]);
      expect(await person.scan("venue_entry", false, reason)).toEqual({ allowed: true, outing: null });
      clock.mockRestore();
    },
  );

  test("starts one Sarvam reminder at the exit deadline, never before it", async () => {
    const f = await overdueCallFixture();
    f.clock.mockReturnValue(f.request.returnBy! - 1);
    await f.advance(); await f.sweep();
    expect(await f.calls()).toEqual([]);
    f.clock.mockReturnValue(f.request.returnBy!);
    await Promise.all([f.advance(), f.advance()]);
    await f.sweep();
    const calls = await f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceType: "participant_outing", sourceId: f.request.requestId,
      targetPersonId: f.person.personId, state: "pending",
      destinationPhoneE164: "+919876543210", attemptCount: 0,
    });
    const deliveryId = calls[0]!._id;
    const claims = await Promise.all(["first", "duplicate"].map((attemptId) =>
      f.backend.mutation(internal.outboundCallState.claimDelivery, { deliveryId, attemptId })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ requiredProvider: "sarvam" });
    expect(calls[0]!.script).toContain("15-minute");
    expect(calls[0]!.script).toContain("other people are waiting for their turn");
    expect(calls[0]!.script).toContain("come back now");
    expect(calls[0]!.script).not.toMatch(/scan|\bID\b/iu);
    expect(calls[0]!.scriptPolicyVersion).toBe("participant-outing-return-v2");
    expect(await f.person.current()).toMatchObject({ status: "overdue", occupiedCount: 1 });
    const roster = await f.ops.query(api.serviceQueues.roster, {
      eventSlug: f.eventSlug, status: "overdue", paginationOpts: { cursor: null, numItems: 25 },
    });
    expect(roster.page[0]).toMatchObject({ id: f.request.requestId, callState: "sending" });
  });

  test("unused permissions and waiting requests never call", async () => {
    const f = await fixture(1);
    const permitted = await f.makePerson("permitted");
    const waiting = await f.makePerson("waiting");
    await permitted.savePhone(); await waiting.savePhone();
    await permitted.request(); await waiting.request();
    const first = await permitted.current(); const second = await waiting.current();
    vi.spyOn(Date, "now").mockReturnValue(first.permissionExpiresAt! + 1);
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: second.requestId! });
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: first.requestId! });
    await f.backend.mutation(internal.serviceQueues.sweepOverdueCalls, { cursor: null });
    expect(await f.backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect())).toEqual([]);
  });

  test("a return before the deadline prevents the call; a later outing gets its own reminder", async () => {
    const f = await overdueCallFixture();
    f.clock.mockReturnValue(f.request.returnBy! - 1);
    await f.person.scan("venue_entry");
    f.clock.mockReturnValue(f.request.returnBy! + 1);
    await f.advance(); await f.sweep();
    expect(await f.calls()).toEqual([]);
    await f.person.request(); await f.person.scan("venue_exit");
    const next = await f.person.current();
    f.clock.mockReturnValue(next.returnBy!);
    await f.backend.mutation(internal.serviceQueues.advanceDeadline, { entryId: next.requestId! });
    expect(await f.calls()).toMatchObject([{ sourceId: next.requestId, state: "pending" }]);
  });

  test.each([false, true])("a recorded return cancels an undispatched call (retry: %s)", async (retry) => {
    const f = await overdueCallFixture();
    await f.advance();
    const deliveryId = (await f.calls())[0]!._id;
    if (retry) await f.backend.run((ctx) => ctx.db.patch(deliveryId, {
      state: "retry_wait", nextAttemptAt: Date.now(), attemptCount: 1,
    }));
    await f.person.scan("venue_entry");
    const claim = await f.backend.mutation(internal.outboundCallState.claimDelivery, { deliveryId, attemptId: "after-return" });
    expect(claim).toBeNull();
    expect(await f.calls()).toMatchObject([{ state: "cancelled", providerErrorCode: "outing_no_longer_overdue" }]);
    expect(await f.person.current()).toMatchObject({ occupiedCount: 0 });
  });

  test.each(["phone", "eligibility", "person", "event", "target"] as const)("rechecks %s before dialing", async (changed) => {
    const f = await overdueCallFixture();
    await f.advance();
    const deliveryId = (await f.calls())[0]!._id;
    await f.backend.run(async (ctx) => {
      if (changed === "phone") await ctx.db.patch(f.profileId!, { phone: "+919876543211" });
      if (changed === "eligibility") await ctx.db.patch(f.person.membershipId, { eligibilityStatus: "suspended" });
      if (changed === "person") await ctx.db.patch(f.person.personId, { status: "suspended" });
      if (changed === "event") await ctx.db.patch(f.eventId, { endsAt: Date.now() });
      if (changed === "target") {
        const operator = await ctx.db.query("people").filter((q) => q.neq(q.field("_id"), f.person.personId)).first();
        await ctx.db.patch(deliveryId, { targetPersonId: operator!._id });
      }
    });
    expect(await f.backend.mutation(internal.outboundCallState.claimDelivery, { deliveryId, attemptId: "stale" })).toBeNull();
    expect((await f.calls())[0]!.state).toBe("cancelled");
  });

  test.each([null, "invalid-phone"])("records unavailable phones without dialing (%s)", async (phone) => {
    const f = await overdueCallFixture(phone);
    await f.advance(); await f.sweep();
    const calls = await f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: "unavailable", attemptCount: 0,
      providerErrorCode: phone === null ? "participant_phone_missing" : "phone_not_e164" });
    expect(await f.backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: calls[0]!._id, attemptId: "unavailable",
    })).toBeNull();
  });

  test("the sweep recovers an existing overdue outing without redialing terminal calls", async () => {
    const f = await overdueCallFixture();
    await f.backend.run(async (ctx) => {
      const entry = await ctx.db.get(f.request.requestId!);
      if (!entry || entry.phase.status !== "out") throw new Error("Expected an outing departure.");
      await ctx.db.patch(entry._id, { phase: { ...entry.phase, status: "overdue" } });
    });
    await f.sweep();
    const deliveryId = (await f.calls())[0]!._id;
    await f.backend.mutation(internal.outboundCallState.recordProviderEvent, {
      deliveryId, providerEventId: crypto.randomUUID(), eventType: "call.no_answer", providerAt: Date.now(),
    });
    await f.sweep(); await f.advance();
    expect(await f.calls()).toMatchObject([{ _id: deliveryId, state: "no_answer" }]);
    expect(await f.calls()).toHaveLength(1);
  });

  test("sends the Sarvam requirement to the voice service and completion never releases capacity", async () => {
    const f = await overdueCallFixture();
    await f.advance();
    const deliveryId = (await f.calls())[0]!._id;
    vi.stubEnv("OUTBOUND_CALL_WORKER_URL", "https://voice.example.test");
    vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.test");
    vi.stubEnv("OUTBOUND_CALL_REQUEST_SECRET", "fixture-secret-at-least-32-bytes-long");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ accepted: true, deliveryId }));
    await f.backend.action(internal.outboundCalls.deliver, { deliveryId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body: unknown = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ deliveryId, requiredProvider: "sarvam", destinationPhoneE164: "+919876543210" });
    await f.backend.mutation(internal.outboundCallState.recordProviderEvent, {
      deliveryId, providerEventId: crypto.randomUUID(), eventType: "call.completed", providerAt: Date.now(),
    });
    expect(await f.person.current()).toMatchObject({ status: "overdue", occupiedCount: 1 });
    await f.sweep();
    expect(await f.calls()).toHaveLength(1);
  });
});
