import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("benefit lifecycle", () => {
  test("keeps exact counters, enforces the code ceiling, and fingerprints code contents", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 1);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const operationId = crypto.randomUUID();
    const created = await operator.mutation(api.benefits.create, {
      eventSlug: fixture.eventSlug,
      name: "Cloud credits",
      scope: "person",
      codeMode: "unique",
      codes: ["CLOUD-A", "CLOUD-B"],
      reason: "Benefit lifecycle test",
      clientOperationId: operationId,
    });

    await expect(
      operator.mutation(api.benefits.create, {
        eventSlug: fixture.eventSlug,
        name: "Cloud credits",
        scope: "person",
        codeMode: "unique",
        codes: ["CHANGED-A", "CHANGED-B"],
        reason: "Benefit lifecycle test",
        clientOperationId: operationId,
      }),
    ).rejects.toThrow("operation ID was already used");

    await operator.mutation(api.benefits.grant, {
      eventSlug: fixture.eventSlug,
      benefitId: created.benefitId,
      target: { kind: "person", email: fixture.participantEmails[0] ?? "" },
      reason: "Grant counter test",
      clientOperationId: crypto.randomUUID(),
    });
    const listed = await operator.query(api.benefits.list, { eventSlug: fixture.eventSlug });
    expect(listed.benefits[0]).toMatchObject({ availableCodes: 1, grantCount: 1 });

    await backend.run((ctx) =>
      ctx.db.patch("benefits", created.benefitId, {
        codeCount: 1_999,
        availableCodeCount: 1_998,
      }),
    );
    await expect(
      operator.mutation(api.benefits.addCodes, {
        eventSlug: fixture.eventSlug,
        benefitId: created.benefitId,
        codes: ["CLOUD-C", "CLOUD-D"],
        reason: "Code ceiling test",
        clientOperationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("holds at most 2000 unique codes");
  });

  test("continues grant-all through every scheduled batch", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 61);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const created = await operator.mutation(api.benefits.create, {
      eventSlug: fixture.eventSlug,
      name: "Shared workspace",
      scope: "person",
      codeMode: "shared",
      sharedCode: "WORK-TOGETHER",
      codes: [],
      reason: "Scheduled grant test",
      clientOperationId: crypto.randomUUID(),
    });
    const operationId = crypto.randomUUID();
    const started = await operator.mutation(api.benefits.grantAll, {
      eventSlug: fixture.eventSlug,
      benefitId: created.benefitId,
      reason: "Grant every participant",
      clientOperationId: operationId,
    });
    expect(started).toMatchObject({ status: "queued", scanned: 0, granted: 0 });

    vi.useFakeTimers();
    try {
      await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    } finally {
      vi.useRealTimers();
    }

    const completed = await operator.mutation(api.benefits.grantAll, {
      eventSlug: fixture.eventSlug,
      benefitId: created.benefitId,
      reason: "Grant every participant",
      clientOperationId: operationId,
    });
    expect(completed).toMatchObject({
      id: started.id,
      status: "complete",
      scanned: 61,
      granted: 61,
      alreadyHad: 0,
      outOfCodes: 0,
    });
    const listed = await operator.query(api.benefits.list, { eventSlug: fixture.eventSlug });
    expect(listed.benefits[0]).toMatchObject({
      availableCodes: 0,
      grantCount: 61,
      latestGrantRun: { status: "complete", scanned: 61, granted: 61 },
    });
  });
});

function seededBackend() {
  const backend = convexTest({ schema, modules });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedFixture(backend: BackendTest, participantCount: number) {
  const now = Date.now();
  const eventSlug = `benefits-${crypto.randomUUID()}`;
  const account = await insertAccount(backend, "operator", now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Benefit fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operatorPersonId = await ctx.db.insert("people", {
      authUserId: account.authUserId,
      googleSubject: `google:${account.authUserId}`,
      verifiedEmail: account.email,
      displayName: "Benefit operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const operatorSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: operatorPersonId,
      emailNormalized: account.email,
      displayName: "Benefit operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["benefit.read", "benefit.manage"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: operatorPersonId,
        eventAccessSubjectId: operatorSubjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `benefit-fixture:${permissionKey}`,
        grantedByPersonId: operatorPersonId,
        reason: "Benefit lifecycle test",
      });
    }

    const participantEmails: string[] = [];
    for (let index = 0; index < participantCount; index += 1) {
      const email = `participant-${index}@example.test`;
      participantEmails.push(email);
      const personId = await ctx.db.insert("people", {
        authUserId: `participant-${index}-${crypto.randomUUID()}`,
        verifiedEmail: email,
        displayName: `Participant ${index}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: email,
        displayName: `Participant ${index}`,
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("eventMemberships", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "accepted",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    return { ...account, eventId, eventSlug, participantEmails };
  });
}

async function insertAccount(backend: BackendTest, name: string, now: number) {
  const email = `${name}-${crypto.randomUUID()}@example.test`;
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name, email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 3_600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  return { email, authUserId, authSessionId: documentId(session, "Better Auth session") };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return an ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid ID.`);
  }
  return id;
}
