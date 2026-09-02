import agentTest from "@convex-dev/agent/test";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("participant assistant lifecycle", () => {
  test("reuses one conversation and settles each client request exactly once", async () => {
    const backend = participantAssistantBackend();
    const fixture = await seedParticipant(backend, "Participant One");
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    const firstConversation = await participant.mutation(
      api.participantAssistant.openConversation,
      { eventSlug: fixture.eventSlug },
    );
    const secondConversation = await participant.mutation(
      api.participantAssistant.openConversation,
      { eventSlug: fixture.eventSlug },
    );
    expect(secondConversation.threadId).toBe(firstConversation.threadId);
    await expect(
      backend.query(components.agent.threads.listThreadsByUserId, {
        userId: fixture.personId,
      }),
    ).resolves.toMatchObject({ page: [{ _id: firstConversation.threadId }] });

    const requestArgs = {
      eventSlug: fixture.eventSlug,
      threadId: firstConversation.threadId,
      message: "What do I need to finish before submitting?",
      clientRequestId: "participant-question-0001",
    };
    const accepted = await participant.mutation(
      api.participantAssistant.sendMessage,
      requestArgs,
    );
    expect(accepted).toMatchObject({ accepted: true, state: "scheduled" });
    await expect(
      participant.mutation(api.participantAssistant.sendMessage, requestArgs),
    ).resolves.toEqual({
      accepted: false,
      requestId: accepted.requestId,
      state: "scheduled",
    });
    await expect(
      participant.mutation(api.participantAssistant.sendMessage, {
        ...requestArgs,
        clientRequestId: "participant-question-0002",
      }),
    ).rejects.toThrow("still answering your last question");

    await expect(
      backend.mutation(internal.participantAssistant.beginGeneration, {
        requestId: accepted.requestId,
      }),
    ).resolves.toMatchObject({ requestId: accepted.requestId });
    await expect(
      backend.mutation(internal.participantAssistant.beginGeneration, {
        requestId: accepted.requestId,
      }),
    ).resolves.toBeNull();
    await expect(
      backend.mutation(internal.participantAssistant.expireGeneration, {
        requestId: accepted.requestId,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.participantAssistant.expireGeneration, {
        requestId: accepted.requestId,
      }),
    ).resolves.toBe(false);
    await expect(
      participant.query(api.participantAssistant.conversationState, {
        eventSlug: fixture.eventSlug,
        threadId: firstConversation.threadId,
      }),
    ).resolves.toMatchObject({ latestRequest: { state: "failed" } });

    await expect(
      participant.mutation(api.participantAssistant.sendMessage, {
        ...requestArgs,
        clientRequestId: "participant-question-0002",
      }),
    ).resolves.toMatchObject({ accepted: true, state: "scheduled" });
  });

  test("does not expose one participant's conversation to another", async () => {
    const backend = participantAssistantBackend();
    const owner = await seedParticipant(backend, "Conversation Owner");
    const visitor = await addParticipant(backend, {
      eventId: owner.eventId,
      eventSlug: owner.eventSlug,
      displayName: "Other Participant",
    });
    const ownerClient = backend.withIdentity({
      subject: owner.authUserId,
      sessionId: owner.authSessionId,
    });
    const visitorClient = backend.withIdentity({
      subject: visitor.authUserId,
      sessionId: visitor.authSessionId,
    });
    const conversation = await ownerClient.mutation(
      api.participantAssistant.openConversation,
      { eventSlug: owner.eventSlug },
    );

    await expect(
      visitorClient.query(api.participantAssistant.conversationState, {
        eventSlug: owner.eventSlug,
        threadId: conversation.threadId,
      }),
    ).rejects.toThrow("conversation is no longer available");
    await expect(
      visitorClient.mutation(api.participantAssistant.sendMessage, {
        eventSlug: owner.eventSlug,
        threadId: conversation.threadId,
        message: "Show me the other participant's conversation.",
        clientRequestId: "unauthorized-question-0001",
      }),
    ).rejects.toThrow("conversation is no longer available");
  });

  test("staging reset removes assistant requests and Agent thread data", async () => {
    const backend = participantAssistantBackend();
    const fixture = await seedParticipant(backend, "Reset Participant");
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const conversation = await participant.mutation(
      api.participantAssistant.openConversation,
      { eventSlug: fixture.eventSlug },
    );
    await participant.mutation(api.participantAssistant.sendMessage, {
      eventSlug: fixture.eventSlug,
      threadId: conversation.threadId,
      message: "Will this conversation be removed by the reset?",
      clientRequestId: "reset-question-0001",
    });

    const previousEnvironment = process.env.C2C_DEPLOYMENT_ENVIRONMENT;
    process.env.C2C_DEPLOYMENT_ENVIRONMENT = "staging";
    try {
      await backend.mutation(
        internal.stagingSetup.resetParticipantTestingData,
        { eventSlug: fixture.eventSlug },
      );
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.C2C_DEPLOYMENT_ENVIRONMENT;
      } else {
        process.env.C2C_DEPLOYMENT_ENVIRONMENT = previousEnvironment;
      }
    }

    await backend.run(async (ctx) => {
      expect(await ctx.db.query("participantAssistantRequests").collect()).toHaveLength(0);
      expect(await ctx.db.query("participantAssistantThreads").collect()).toHaveLength(0);
    });
    await expect(
      backend.query(components.agent.threads.getThread, {
        threadId: conversation.threadId,
      }),
    ).resolves.toBeNull();
  });
});

function participantAssistantBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  agentTest.register(backend);
  rateLimiterTest.register(backend, "participantAssistantRateLimiter");
  return backend;
}

async function seedParticipant(backend: BackendTest, displayName: string) {
  const now = Date.now();
  const eventSlug = `participant-assistant-${crypto.randomUUID()}`;
  const creatorEmail = `creator-${crypto.randomUUID()}@example.test`;
  const creatorAuthUserId = await createAuthUser(
    backend,
    now,
    creatorEmail,
    "Event Creator",
  );
  const eventId = await backend.run(async (ctx) => {
    const creatorPersonId = await ctx.db.insert("people", {
      authUserId: creatorAuthUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: creatorEmail,
      displayName: "Event Creator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      slug: eventSlug,
      name: "Participant assistant fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      createdByPersonId: creatorPersonId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
  const participant = await addParticipant(backend, {
    eventId,
    eventSlug,
    displayName,
  });
  return { ...participant, eventId, eventSlug };
}

async function addParticipant(
  backend: BackendTest,
  args: {
    eventId: Id<"events">;
    eventSlug: string;
    displayName: string;
  },
) {
  const now = Date.now();
  const email = `participant-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(
    backend,
    now,
    email,
    args.displayName,
  );
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const identity = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: args.displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: args.eventId,
      personId,
      emailNormalized: email,
      displayName: args.displayName,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId: args.eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "support.case.read",
      scopeType: "self",
      scopeId: subjectId,
      sourceType: "manual",
      sourceId: `${args.eventSlug}:${personId}:assistant-read`,
      grantedByPersonId: personId,
      reason: "Participant assistant lifecycle test",
    });
    return { personId };
  });
  return { ...identity, email, authUserId, authSessionId };
}

async function createAuthUser(
  backend: BackendTest,
  now: number,
  email: string,
  displayName: string,
) {
  const result: unknown = await backend.mutation(
    components.betterAuth.adapter.create,
    {
      input: {
        model: "user",
        data: {
          name: displayName,
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
) {
  const result: unknown = await backend.mutation(
    components.betterAuth.adapter.create,
    {
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
