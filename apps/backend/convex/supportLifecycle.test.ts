import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("support projections", () => {
  test("case mutations update the event counters in the same transaction", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const created = await operator.mutation(api.support.createStaff, {
      eventSlug: fixture.eventSlug,
      category: "safety",
      description: "A power cable is exposed beside the participant queue.",
      clientOperationId: crypto.randomUUID(),
    });
    await expect(
      operator.query(api.support.detailByPublicCode, {
        eventSlug: fixture.eventSlug,
        publicCode: created.publicCode,
      }),
    ).resolves.toMatchObject({
      viewer: "staff",
      supportCase: { id: created.id, publicCode: created.publicCode },
    });

    let list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "active",
    });
    expect(list.totals).toMatchObject({
      open: 1,
      unowned: 1,
      awaitingStaffReply: 1,
      safety: 1,
    });
    expect(list.cases[0]).toMatchObject({
      id: created.id,
      lastActionAt: expect.any(Number),
      awaitingStaffReply: true,
    });
    await expect(
      operator.query(api.support.mineSummary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ openCount: 1, countIsLowerBound: false });
    await expect(
      operator.query(api.support.owners, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual([
      { personId: fixture.personId, displayName: "Support operator" },
    ]);

    await operator.mutation(api.support.updateStaff, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: created.version,
      nextState: "investigating",
      nextOwnerPersonId: fixture.personId,
      clearOwner: false,
      publicNote: "The cable is isolated; facilities are replacing it now.",
      reason: "Assigned the safety report and told the reporter what changed.",
      clientOperationId: crypto.randomUUID(),
    });
    list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "active",
    });
    expect(list.totals).toMatchObject({
      open: 0,
      investigating: 1,
      unowned: 0,
      awaitingStaffReply: 0,
      safety: 1,
    });
    expect(list.cases[0]?.firstResponseAt).toEqual(expect.any(Number));

    const replied = await operator.mutation(api.support.replySelf, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: 2,
      message: "The exposed cable is still visible from the queue.",
      clientOperationId: crypto.randomUUID(),
    });
    expect(replied.version).toBe(3);
    list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "active",
    });
    expect(list.totals).toMatchObject({
      investigating: 1,
      unowned: 0,
      awaitingStaffReply: 1,
      safety: 1,
    });

    await operator.mutation(api.support.updateStaff, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: 3,
      nextState: "resolved",
      clearOwner: false,
      reason: "Facilities replaced the cable and inspected the queue edge.",
      clientOperationId: crypto.randomUUID(),
    });
    list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "resolved",
    });
    expect(list.totals).toMatchObject({
      investigating: 0,
      resolved: 1,
      awaitingStaffReply: 0,
      safety: 0,
    });

    const statVersion = await backend.run(async (ctx) => {
      const shards = await ctx.db
        .query("supportCaseStatShards")
        .withIndex("by_event_shard", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      return shards[0]?.version;
    });
    await operator.mutation(api.support.updateStaff, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: 4,
      clearOwner: false,
      internalNote: "Facilities ticket 428 is attached to the physical incident log.",
      reason: "Recorded the facilities reference for the event desk.",
      clientOperationId: crypto.randomUUID(),
    });
    expect(
      await backend.run(async (ctx) => {
        const shards = await ctx.db
          .query("supportCaseStatShards")
          .withIndex("by_event_shard", (index) => index.eq("eventId", fixture.eventId))
          .collect();
        return shards[0]?.version;
      }),
    ).toBe(statVersion);

    await operator.mutation(api.support.replySelf, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: 5,
      message: "The cable cover has come loose again.",
      clientOperationId: crypto.randomUUID(),
    });
    list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "active",
    });
    expect(list.totals).toMatchObject({
      open: 1,
      resolved: 0,
      unowned: 0,
      awaitingStaffReply: 1,
      safety: 1,
    });
    const auditReasons = await backend.run(async (ctx) => {
      const rows = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      return rows.map((row) => row.reason);
    });
    expect(auditReasons).toContain("Staff opened a support case.");
    expect(auditReasons).toContain("Reporter added a support reply.");
    expect(auditReasons).not.toContain(
      "A power cable is exposed beside the participant queue.",
    );
    expect(auditReasons).not.toContain(
      "The exposed cable is still visible from the queue.",
    );
    expect(auditReasons).not.toContain("The cable cover has come loose again.");

    const revokedReadCount = await backend.run(async (ctx) => {
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "support.case.read")
            .eq("status", "active"),
        )
        .collect();
      for (const grant of grants) {
        await ctx.db.patch(grant._id, {
          status: "revoked",
          revokedAt: Date.now(),
          revokedByPersonId: fixture.personId,
          revokeReason: "Permission-revocation projection test",
        });
      }
      return grants.length;
    });
    expect(revokedReadCount).toBeGreaterThan(0);
    await expect(
      operator.query(api.support.mine, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual([]);
    await expect(
      operator.query(api.support.mineSummary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ openCount: 0, countIsLowerBound: false });
    await expect(
      operator.query(api.support.detail, {
        eventSlug: fixture.eventSlug,
        supportCaseId: created.id,
      }),
    ).resolves.toBeNull();
    await expect(
      operator.query(api.support.detailByPublicCode, {
        eventSlug: fixture.eventSlug,
        publicCode: created.publicCode,
      }),
    ).resolves.toBeNull();
  });

  test("event-wide lists read a bounded indexed page and keep exact totals", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const now = Date.now();
    await backend.run(async (ctx) => {
      let firstCaseId: Id<"supportCases"> | undefined;
      for (let index = 0; index < 85; index += 1) {
        const supportCaseId = await ctx.db.insert("supportCases", {
          eventId: fixture.eventId,
          publicCode: `C2C-${String(index).padStart(4, "0")}`,
          category: "queue",
          description: `Queue question ${index}`,
          origin: "staff",
          reporterPersonId: fixture.personId,
          reporterEventAccessSubjectId: fixture.subjectId,
          contactEmail: fixture.email,
          state: "open",
          lastActionAt: now + index,
          awaitingStaffReply: true,
          version: 1,
          createdAt: now + index,
          updatedAt: now + index,
        });
        firstCaseId ??= supportCaseId;
      }
      if (firstCaseId === undefined) throw new Error("The fixture created no support case.");
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert("supportCaseActions", {
          eventId: fixture.eventId,
          supportCaseId: firstCaseId,
          kind: "internal_note",
          visibility: "internal",
          actorPersonId: fixture.personId,
          body: `Historical action ${index}`,
          createdAt: now + 1_000 + index,
        });
      }
      await ctx.db.insert("supportCaseStatShards", {
        eventId: fixture.eventId,
        shard: 0,
        open: 85,
        investigating: 0,
        waiting: 0,
        resolved: 0,
        closed: 0,
        unowned: 85,
        awaitingStaffReply: 85,
        safety: 0,
        version: 85,
        updatedAt: now + 84,
      });
    });

    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const list = await operator.query(api.support.staffList, {
      eventSlug: fixture.eventSlug,
      state: "active",
    });
    expect(list.cases).toHaveLength(80);
    expect(list.caseLimitReached).toBe(true);
    expect(list.totals).toMatchObject({
      open: 85,
      unowned: 85,
      awaitingStaffReply: 85,
    });
    expect(list.cases[0]?.publicCode).toBe("C2C-0084");
    expect(list.cases.at(-1)?.publicCode).toBe("C2C-0005");
    await expect(
      operator.query(api.support.mineSummary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ openCount: 20, countIsLowerBound: true });
  });

  test("operation retries return the version produced by the original support change", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const createOperationId = crypto.randomUUID();
    const createArgs = {
      eventSlug: fixture.eventSlug,
      category: "queue" as const,
      description: "The participant needs help finding the next event activity.",
      clientOperationId: createOperationId,
    };
    const created = await operator.mutation(api.support.createStaff, createArgs);
    const updateOperationId = crypto.randomUUID();
    const updateArgs = {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: created.version,
      nextState: "investigating" as const,
      clearOwner: false,
      reason: "The event desk is checking the participant's schedule.",
      clientOperationId: updateOperationId,
    };
    const updated = await operator.mutation(api.support.updateStaff, updateArgs);
    const replyOperationId = crypto.randomUUID();
    const replyArgs = {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: updated.version,
      message: "I am waiting beside the event desk now.",
      clientOperationId: replyOperationId,
    };
    const replied = await operator.mutation(api.support.replySelf, replyArgs);
    await operator.mutation(api.support.updateStaff, {
      eventSlug: fixture.eventSlug,
      supportCaseId: created.id,
      expectedVersion: replied.version,
      nextState: "resolved",
      clearOwner: false,
      reason: "The participant received the correct activity and location.",
      clientOperationId: crypto.randomUUID(),
    });

    await expect(
      operator.mutation(api.support.createStaff, createArgs),
    ).resolves.toEqual(created);
    await expect(
      operator.mutation(api.support.updateStaff, updateArgs),
    ).resolves.toEqual(updated);
    await expect(
      operator.mutation(api.support.replySelf, replyArgs),
    ).resolves.toEqual(replied);
    await expect(
      operator.query(api.support.detail, {
        eventSlug: fixture.eventSlug,
        supportCaseId: created.id,
      }),
    ).resolves.toMatchObject({ supportCase: { version: 4 } });
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedOperator(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `support-${crypto.randomUUID()}`;
  const email = `support-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(backend, now, email);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const identity = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: "Support operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Support fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Support operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of [
      "support.case.create",
      "support.case.read",
      "support.case.manage",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventSlug}:${permissionKey}`,
        grantedByPersonId: personId,
        reason: "Support projection test",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "support.case.reply",
      scopeType: "self",
      scopeId: subjectId,
      sourceType: "manual",
      sourceId: `${eventSlug}:reply`,
      grantedByPersonId: personId,
      reason: "Support projection test",
    });
    return { eventId, personId, subjectId };
  });
  return { ...identity, eventSlug, email, authUserId, authSessionId };
}

async function createAuthUser(backend: BackendTest, now: number, email: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Support operator",
        email,
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
        expiresAt: now + 60 * 60_000,
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
