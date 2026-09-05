import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("participant outing permission queue", () => {
  test("keeps participants ordered and makes joining idempotent", async () => {
    const backend = seededBackend();
    const now = Date.now();
    const eventSlug = `service-queues-${crypto.randomUUID()}`;
    const eventId = await backend.run((ctx) => ctx.db.insert("events", {
      slug: eventSlug,
      name: "Service queue fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const first = backend.withIdentity(await createParticipant(backend, eventId, "first", now));
    const second = backend.withIdentity(await createParticipant(backend, eventId, "second", now + 1));

    await expect(first.mutation(api.serviceQueues.join, {
      eventSlug,
      kind: "outing_permission",
    })).resolves.toMatchObject({ joined: true });
    await expect(first.mutation(api.serviceQueues.join, {
      eventSlug,
      kind: "outing_permission",
    })).resolves.toMatchObject({ joined: false });
    await second.mutation(api.serviceQueues.join, { eventSlug, kind: "outing_permission" });

    await expect(second.query(api.serviceQueues.current, { eventSlug })).resolves.toEqual([
      {
        kind: "outing_permission",
        joined: true,
        position: 2,
        waitingCount: 2,
        joinedAt: expect.any(Number),
      },
    ]);

    await first.mutation(api.serviceQueues.leave, { eventSlug, kind: "outing_permission" });
    await expect(second.query(api.serviceQueues.current, { eventSlug })).resolves.toEqual([
      {
        kind: "outing_permission",
        joined: true,
        position: 1,
        waitingCount: 1,
        joinedAt: expect.any(Number),
      },
    ]);

    await backend.run((ctx) => ctx.db.patch(eventId, { status: "complete", updatedAt: now + 2 }));
    await expect(first.query(api.serviceQueues.current, { eventSlug })).resolves.toEqual([]);
    await expect(first.mutation(api.serviceQueues.join, {
      eventSlug,
      kind: "outing_permission",
    })).rejects.toThrow("The outing permission queue is available while the event is live");
  });

  test("reads position and size without scanning the queue", async () => {
    const backend = seededBackend(64);
    const now = Date.now();
    const eventSlug = `service-queues-scale-${crypto.randomUUID()}`;
    const eventId = await backend.run((ctx) => ctx.db.insert("events", {
      slug: eventSlug,
      name: "Service queue scale fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    let lastParticipant: ReturnType<BackendTest["withIdentity"]> | null = null;
    for (let index = 0; index < 80; index += 1) {
      const participant = backend.withIdentity(
        await createParticipant(backend, eventId, `participant-${index}`, now + index),
      );
      await participant.mutation(api.serviceQueues.join, {
        eventSlug,
        kind: "outing_permission",
      });
      lastParticipant = participant;
    }
    if (!lastParticipant) throw new Error("The scale fixture did not create a participant.");

    await expect(lastParticipant.query(api.serviceQueues.current, { eventSlug })).resolves.toEqual([
      {
        kind: "outing_permission",
        joined: true,
        position: 80,
        waitingCount: 80,
        joinedAt: expect.any(Number),
      },
    ]);
  });
});

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
  await backend.run(async (ctx) => {
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
  });
  return { subject: authUserId, sessionId: authSessionId };
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
