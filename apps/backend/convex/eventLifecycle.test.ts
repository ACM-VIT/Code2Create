import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import {
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  normalizeAdmissionConfiguration,
} from "./lib/admissionPolicy.ts";
import {
  eventLifecycleBlockers,
  eventLifecycleTargets,
  eventLifecycleTransitionAllowed,
  type EventLifecycleConfiguration,
} from "./lib/eventLifecycle.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy.ts";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

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

const emptyConfiguration: EventLifecycleConfiguration = {
  hasActiveAttendanceSession: false,
  hasActiveReviewRound: false,
  hasAdmissionPolicy: false,
  hasAttendancePlan: false,
  hasCommunicationsPolicy: false,
  hasEventDates: false,
  hasIntegrationPolicy: false,
  hasIntakePolicy: false,
  hasParticipantPolicy: false,
  hasPhaseSchedule: false,
  hasProjectCheckpointPlan: false,
  hasPublishedReviewRound: false,
  hasFutureApplicationDeadline: false,
};

describe("event lifecycle", () => {
  test("keeps lifecycle visibility and control independently event scoped", () => {
    expect(permissionCatalog["event.lifecycle.read"]).toEqual({ scopes: [], eventWide: true });
    expect(permissionCatalog["event.lifecycle.manage"]).toEqual({ scopes: [], eventWide: true });
  });

  test("uses one explicit forward path with a deliberate registration reopen", () => {
    expect(eventLifecycleTargets("draft")).toEqual(["registration_open"]);
    expect(eventLifecycleTargets("registration_open")).toEqual(["registration_closed"]);
    expect(eventLifecycleTargets("registration_closed")).toEqual(["live", "registration_open"]);
    expect(eventLifecycleTargets("live")).toEqual(["complete"]);
    expect(eventLifecycleTargets("complete")).toEqual([]);
    expect(eventLifecycleTransitionAllowed("registration_open", "live")).toBe(false);
    expect(eventLifecycleTransitionAllowed("registration_closed", "registration_open")).toBe(true);
  });

  test("names incomplete setup before applications open or the event starts", () => {
    expect(
      eventLifecycleBlockers("registration_open", emptyConfiguration).map((item) => item.key),
    ).toEqual([
      "future_application_deadline",
      "event_dates",
      "participant_policy",
      "intake_policy",
      "admission_policy",
    ]);
    expect(eventLifecycleBlockers("live", emptyConfiguration).map((item) => item.key)).toEqual([
      "event_dates",
      "communications_policy",
      "phase_schedule",
      "checkpoint_plan",
      "attendance_plan",
      "integration_policy",
      "review_round",
    ]);
    expect(
      eventLifecycleBlockers("complete", {
        ...emptyConfiguration,
        hasActiveAttendanceSession: true,
        hasActiveReviewRound: true,
      }).map((item) => item.key),
    ).toEqual(["active_attendance_session", "active_review_round"]);
  });

  test("closes and reopens applications with permission, audit, and idempotency", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    const before = await operator.query(api.eventLifecycle.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(before).toMatchObject({
      status: "registration_open",
      eventVersion: 1,
      canManage: true,
      transitions: [{ targetStatus: "registration_closed", blockers: [] }],
    });

    const closeRequest = {
      eventSlug: fixture.eventSlug,
      targetStatus: "registration_closed",
      expectedEventVersion: 1,
      reason: "The published application window has ended.",
      clientOperationId: "close-applications-once",
    } as const;
    const closed = await operator.mutation(api.eventLifecycle.transition, closeRequest);
    expect(closed).toEqual({ status: "registration_closed", eventVersion: 2 });
    expect(await operator.mutation(api.eventLifecycle.transition, closeRequest)).toEqual(closed);

    const afterClose = await operator.query(api.eventLifecycle.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(afterClose.status).toBe("registration_closed");
    expect(
      afterClose.transitions.find((transition) => transition.targetStatus === "live")?.blockers,
    ).toHaveLength(6);
    await expect(
      operator.mutation(api.eventLifecycle.transition, {
        eventSlug: fixture.eventSlug,
        targetStatus: "live",
        expectedEventVersion: 2,
        reason: "Begin the event build window.",
        clientOperationId: "start-with-incomplete-setup",
      }),
    ).rejects.toThrow("Finish this setup first");

    const reopened = await operator.mutation(api.eventLifecycle.transition, {
      eventSlug: fixture.eventSlug,
      targetStatus: "registration_open",
      expectedEventVersion: 2,
      reason: "Reopen the published application window after the timing correction.",
      clientOperationId: "reopen-applications-once",
    });
    expect(reopened).toEqual({ status: "registration_open", eventVersion: 3 });

    await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.eventId);
      expect(event?.status).toBe("registration_open");
      expect(event?.version).toBe(3);
      expect(
        await ctx.db
          .query("operationResults")
          .withIndex("by_actor_operation", (index) =>
            index
              .eq("actorPersonId", fixture.personId)
              .eq("clientOperationId", closeRequest.clientOperationId),
          )
          .collect(),
      ).toHaveLength(1);
      const auditEvents = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      expect(
        auditEvents.filter((event) => event.action === "event_lifecycle_transitioned"),
      ).toHaveLength(2);
    });
  });

  test("serializes two operators acting on the same event version", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const attempts = await Promise.allSettled([
      operator.mutation(api.eventLifecycle.transition, {
        eventSlug: fixture.eventSlug,
        targetStatus: "registration_closed",
        expectedEventVersion: 1,
        reason: "The application window has ended.",
        clientOperationId: "close-race-one",
      }),
      operator.mutation(api.eventLifecycle.transition, {
        eventSlug: fixture.eventSlug,
        targetStatus: "registration_closed",
        expectedEventVersion: 1,
        reason: "The application window has ended.",
        clientOperationId: "close-race-two",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  test("closes registration once when the configured deadline arrives", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedOperator(backend);
    const deadline = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.eventId);
      if (!event) throw new Error("Lifecycle fixture event is missing.");
      return event.applicationsCloseAt;
    });

    await backend.mutation(internal.eventLifecycle.closeRegistrationAtDeadline, {
      eventId: fixture.eventId,
      expectedApplicationsCloseAt: deadline,
    });
    expect(await lifecycleState(backend, fixture.eventId)).toEqual({
      status: "registration_open",
      version: 1,
      deadlineAuditCount: 0,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline);
    try {
      const request = {
        eventId: fixture.eventId,
        expectedApplicationsCloseAt: deadline,
      } as const;
      await backend.mutation(internal.eventLifecycle.closeRegistrationAtDeadline, request);
      await backend.mutation(internal.eventLifecycle.closeRegistrationAtDeadline, request);
      expect(await lifecycleState(backend, fixture.eventId)).toEqual({
        status: "registration_closed",
        version: 2,
        deadlineAuditCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("refreshes realtime reads once when the external deadline arrives", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedOperator(backend);
    const eventBefore = await backend.run(async (ctx) => ctx.db.get(fixture.eventId));
    if (!eventBefore?.externalApplicationsCloseAt) {
      throw new Error("The external deadline fixture is missing.");
    }
    const request = {
      eventId: fixture.eventId,
      expectedExternalApplicationsCloseAt: eventBefore.externalApplicationsCloseAt,
    } as const;

    await backend.mutation(
      internal.eventLifecycle.markExternalRegistrationClosedAtDeadline,
      request,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(eventBefore.externalApplicationsCloseAt);
    try {
      await backend.mutation(
        internal.eventLifecycle.markExternalRegistrationClosedAtDeadline,
        request,
      );
      await backend.mutation(
        internal.eventLifecycle.markExternalRegistrationClosedAtDeadline,
        request,
      );
      const result = await backend.run(async (ctx) => {
        const event = await ctx.db.get(fixture.eventId);
        const auditEvents = await ctx.db
          .query("auditEvents")
          .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
          .collect();
        return {
          status: event?.status,
          version: event?.version,
          updatedAt: event?.updatedAt,
          deadlineAuditCount: auditEvents.filter(
            (auditEvent) => auditEvent.action === "event_external_registration_closed_at_deadline",
          ).length,
        };
      });
      expect(result).toEqual({
        status: "registration_open",
        version: 1,
        updatedAt: eventBefore.externalApplicationsCloseAt,
        deadlineAuditCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

async function lifecycleState(
  backend: BackendTest,
  eventId: Awaited<ReturnType<typeof seedOperator>>["eventId"],
) {
  return backend.run(async (ctx) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Lifecycle fixture event is missing.");
    const auditEvents = await ctx.db
      .query("auditEvents")
      .withIndex("by_event_time", (index) => index.eq("eventId", eventId))
      .collect();
    return {
      status: event.status,
      version: event.version,
      deadlineAuditCount: auditEvents.filter(
        (auditEvent) => auditEvent.action === "event_registration_closed_at_deadline",
      ).length,
    };
  });
}

async function seedOperator(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `event-lifecycle-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google-${eventSlug}`,
      verifiedEmail: `${eventSlug}@example.test`,
      displayName: "Lifecycle operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Code2Create lifecycle fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      externalApplicationsCloseAt: now + 12 * 60 * 60 * 1_000,
      applicationsCloseAt: now + 86_400_000,
      startsAt: now + 2 * 86_400_000,
      endsAt: now + 2 * 86_400_000 + 60_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicy = normalizeParticipantPolicy(defaultParticipantPolicy);
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...participantPolicy,
      checksum: participantPolicyChecksum(participantPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicy = normalizeIntakePolicy(defaultDeterministicIntakePolicy);
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionConfiguration = normalizeAdmissionConfiguration({
      version: "admission-v1",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
      model: null,
    });
    const admissionPolicy = admissionPolicyForConfiguration(admissionConfiguration);
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${eventSlug}@example.test`,
      displayName: "Lifecycle operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["event.lifecycle.read", "event.lifecycle.manage"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventSlug}:${permissionKey}`,
        grantedByPersonId: personId,
        reason: "Event lifecycle test",
      });
    }
    return { eventSlug, eventId, personId, authUserId, authSessionId };
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Lifecycle operator",
        email: `lifecycle-${crypto.randomUUID()}@example.test`,
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
