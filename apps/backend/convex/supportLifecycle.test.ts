import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import {
  discordSupportBridgeProtocolVersion,
  discordSupportPullSignatureContext,
  signServiceBody,
} from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";
import { appendParticipantAssistantSupportMessage } from "./support";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("support projections", () => {
  test("the Discord bridge rejects unsigned pulls", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const body = JSON.stringify({
      protocolVersion: discordSupportBridgeProtocolVersion,
      eventSlug: fixture.eventSlug,
    });
    const previousEnvironment = {
      AUTH_SITE_URL: process.env.AUTH_SITE_URL,
      PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
      OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
      DISCORD_SUPPORT_BRIDGE_SECRET: process.env.DISCORD_SUPPORT_BRIDGE_SECRET,
    };
    const secret = `test-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    process.env.AUTH_SITE_URL = "http://localhost:3211";
    process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
    process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
    process.env.DISCORD_SUPPORT_BRIDGE_SECRET = secret;
    try {
      const unsigned = await backend.fetch("/integrations/discord/support/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(unsigned.status).toBe(401);
      const timestamp = Date.now().toString();
      const signature = await signServiceBody({
        context: discordSupportPullSignatureContext,
        secret,
        timestamp,
        body,
      });
      const signed = await backend.fetch("/integrations/discord/support/pull", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-c2c-signature": signature,
          "x-c2c-timestamp": timestamp,
        },
        body,
      });
      expect(signed.status).toBe(200);
      await expect(signed.json()).resolves.toEqual({ state: "idle" });
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("Discord delivery and replies stay idempotent and use normal support actions", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const created = await operator.mutation(api.support.createStaff, {
      eventSlug: fixture.eventSlug,
      category: "queue",
      description: "The participant needs the correct queue location.",
      clientOperationId: crypto.randomUUID(),
    });
    const claimed = await backend.mutation(internal.supportDiscordBridge.claimNext, {
      eventSlug: fixture.eventSlug,
    });
    expect(claimed).toMatchObject({
      state: "work",
      delivery: {
        action: { kind: "opened" },
        supportCase: { id: created.id, publicCode: created.publicCode },
      },
    });
    if (claimed.state !== "work") throw new Error("The Discord delivery was not claimed.");
    await expect(
      backend.mutation(internal.supportDiscordBridge.acknowledgeDelivery, {
        deliveryId: claimed.delivery.id,
        claimId: claimed.delivery.claimId,
        discordGuildId: "1411784063571988722",
        discordChannelId: "1555555555555555555",
        discordMessageId: "1666666666666666666",
      }),
    ).resolves.toBe("accepted");

    const previousActorEmail = process.env.DISCORD_SUPPORT_ACTOR_EMAIL;
    process.env.DISCORD_SUPPORT_ACTOR_EMAIL = fixture.email;
    try {
      const reply = {
        eventSlug: fixture.eventSlug,
        discordGuildId: "1411784063571988722",
        discordChannelId: "1555555555555555555",
        discordMessageId: "1777777777777777777",
        discordUserId: "1888888888888888888",
        discordDisplayName: "Discord operator",
        message: "Use the north registration queue beside the auditorium.",
      };
      await expect(
        backend.mutation(internal.supportDiscordBridge.recordReply, reply),
      ).resolves.toMatchObject({
        state: "accepted",
        publicCode: created.publicCode,
        version: 2,
      });
      await expect(
        backend.mutation(internal.supportDiscordBridge.recordReply, reply),
      ).resolves.toMatchObject({
        state: "already_recorded",
        publicCode: created.publicCode,
        version: 2,
      });
    } finally {
      if (previousActorEmail === undefined) {
        delete process.env.DISCORD_SUPPORT_ACTOR_EMAIL;
      } else {
        process.env.DISCORD_SUPPORT_ACTOR_EMAIL = previousActorEmail;
      }
    }

    await expect(
      operator.query(api.support.detail, {
        eventSlug: fixture.eventSlug,
        supportCaseId: created.id,
      }),
    ).resolves.toMatchObject({
      supportCase: { version: 2, awaitingStaffReply: false },
      actions: expect.arrayContaining([
        expect.objectContaining({
          kind: "public_note",
          actorName: "Discord operator",
          source: "discord",
          body: "Use the north registration queue beside the auditorium.",
        }),
      ]),
    });
    const bridgeRows = await backend.run(async (ctx) => ({
      outbound: await ctx.db.query("supportDiscordOutbox").collect(),
      inbound: await ctx.db.query("supportDiscordInboundMessages").collect(),
    }));
    expect(bridgeRows.outbound).toHaveLength(1);
    expect(bridgeRows.outbound[0]?.state).toBe("delivered");
    expect(bridgeRows.inbound).toHaveLength(1);
  });

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
    ).resolves.toEqual([{ personId: fixture.personId, displayName: "Support operator" }]);

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
    expect(auditReasons).not.toContain("A power cable is exposed beside the participant queue.");
    expect(auditReasons).not.toContain("The exposed cable is still visible from the queue.");
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

    await expect(operator.mutation(api.support.createStaff, createArgs)).resolves.toEqual(created);
    await expect(operator.mutation(api.support.updateStaff, updateArgs)).resolves.toEqual(updated);
    await expect(operator.mutation(api.support.replySelf, replyArgs)).resolves.toEqual(replied);
    await expect(
      operator.query(api.support.detail, {
        eventSlug: fixture.eventSlug,
        supportCaseId: created.id,
      }),
    ).resolves.toMatchObject({ supportCase: { version: 4 } });
  });

  test("the Guide uses one human conversation and reopens it when the participant returns", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const threadId = `guide-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      await ctx.db.insert("participantAssistantThreads", {
        eventId: fixture.eventId,
        personId: fixture.personId,
        threadId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await backend.mutation(internal.participantAssistant.escalateToHuman, {
      threadId,
      category: "identity",
      summary: "The participant cannot correct the name on their event profile.",
      transcript:
        "Participant: My name is wrong on my pass.\n\nGuide: I can bring in the event team to correct it.",
    });
    expect(first).toEqual({ status: "joined", state: "open" });
    const second = await backend.mutation(internal.participantAssistant.escalateToHuman, {
      threadId,
      category: "identity",
      summary: "The participant still needs the same profile correction.",
      transcript: "Participant: Has someone seen this yet?",
    });
    expect(second).toEqual({ status: "already_joined", state: "open" });

    const linked = await backend.run(async (ctx) => {
      const conversation = await ctx.db
        .query("participantAssistantThreads")
        .withIndex("by_threadId", (index) => index.eq("threadId", threadId))
        .unique();
      const cases = await ctx.db
        .query("supportCases")
        .withIndex("by_event_reporter_updated", (index) =>
          index.eq("eventId", fixture.eventId).eq("reporterPersonId", fixture.personId),
        )
        .collect();
      return { conversation, cases };
    });
    expect(linked.cases).toHaveLength(1);
    const supportCaseId = linked.conversation?.supportCaseId;
    if (supportCaseId === undefined) {
      throw new Error("The Guide did not link the human support conversation.");
    }

    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    await operator.mutation(api.support.updateStaff, {
      eventSlug: fixture.eventSlug,
      supportCaseId,
      expectedVersion: 1,
      nextState: "closed",
      clearOwner: false,
      publicNote: "We corrected the profile name.",
      reason: "The participant profile now matches their identity document.",
      clientOperationId: crypto.randomUUID(),
    });
    await backend.run((ctx) =>
      appendParticipantAssistantSupportMessage(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        supportCaseId,
        message: "The old spelling is still showing on my pass.",
        now: Date.now(),
      }),
    );

    await expect(
      operator.query(api.support.detail, {
        eventSlug: fixture.eventSlug,
        supportCaseId,
      }),
    ).resolves.toMatchObject({
      supportCase: {
        state: "open",
        version: 3,
        awaitingStaffReply: true,
      },
      actions: expect.arrayContaining([
        expect.objectContaining({
          kind: "internal_note",
          actorName: "Code2Create Guide",
          body: expect.stringContaining("Conversation so far"),
        }),
        expect.objectContaining({
          kind: "reporter_reply",
          body: "The old spelling is still showing on my pass.",
        }),
        expect.objectContaining({
          kind: "state_changed",
          previousState: "closed",
          nextState: "open",
        }),
      ]),
    });
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
      permissionKey: "support.case.create",
      scopeType: "self",
      scopeId: subjectId,
      sourceType: "manual",
      sourceId: `${eventSlug}:create-self`,
      grantedByPersonId: personId,
      reason: "Support projection test",
    });
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
