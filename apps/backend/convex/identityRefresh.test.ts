import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { refreshExistingPersonIdentity } from "./lib/identity";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("existing person identity refresh", () => {
  test("updates the person and all event subjects and advances email-sensitive access versions", async () => {
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const ids = await backend.run(async (ctx) => {
      const authUserId = crypto.randomUUID();
      const googleSubject = crypto.randomUUID();
      const personId = await ctx.db.insert("people", {
        authUserId,
        googleSubject,
        verifiedEmail: "old@example.test",
        displayName: "Old name",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventIds: Id<"events">[] = [];
      const subjectIds: Id<"eventAccessSubjects">[] = [];
      for (const slug of ["identity-one", "identity-two"]) {
        const eventId = await ctx.db.insert("events", {
          slug: `${slug}-${crypto.randomUUID()}`,
          name: slug,
          timezone: "Asia/Kolkata",
          status: "draft",
          vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
          startsAt: now,
          endsAt: now + 1_000,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        eventIds.push(eventId);
        subjectIds.push(
          await ctx.db.insert("eventAccessSubjects", {
            eventId,
            personId,
            emailNormalized: "old@example.test",
            displayName: "Old name",
            status: "active",
            linkedBy: "access_invitation",
            accessVersion: 4,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      return { authUserId, googleSubject, personId, eventIds, subjectIds };
    });

    await backend.mutation(internal.identityClaims.recordVerifiedGoogleIdentity, {
      authUserId: ids.authUserId,
      googleSubject: ids.googleSubject,
      verifiedEmail: "new@example.test",
      displayName: "New name",
      tokenIssuedAt: now,
      tokenExpiresAt: now + 60_000,
      verifiedAt: now + 1,
    });

    const stored = await backend.run(async (ctx) => ({
      person: await ctx.db.get(ids.personId),
      subjects: await Promise.all(ids.subjectIds.map((subjectId) => ctx.db.get(subjectId))),
      claim: await ctx.db
        .query("googleIdentityClaims")
        .withIndex("by_auth_user", (query) => query.eq("authUserId", ids.authUserId))
        .unique(),
    }));
    expect(stored.person).toMatchObject({
      verifiedEmail: "new@example.test",
      displayName: "New name",
    });
    expect(stored.claim).toMatchObject({
      verifiedEmail: "new@example.test",
      displayName: "New name",
    });
    expect(stored.subjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          emailNormalized: "new@example.test",
          displayName: "New name",
          accessVersion: 5,
        }),
        expect.objectContaining({
          emailNormalized: "new@example.test",
          displayName: "New name",
          accessVersion: 5,
        }),
      ]),
    );
  });

  test("rejects global and event-scoped email ownership conflicts without partial updates", async () => {
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const fixture = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `identity-conflict-${crypto.randomUUID()}`,
        name: "Identity conflict",
        timezone: "Asia/Kolkata",
        status: "draft",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: now,
        endsAt: now + 1_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await insertPerson(ctx, "old@example.test", now);
      const otherPersonId = await insertPerson(ctx, "owned@example.test", now);
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "old@example.test",
        displayName: "Person",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId: otherPersonId,
        emailNormalized: "event-owned@example.test",
        displayName: "Other",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { personId, subjectId };
    });

    await expect(
      backend.run(async (ctx) => {
        const person = await ctx.db.get(fixture.personId);
        if (!person) throw new Error("Identity fixture is missing.");
        return refreshExistingPersonIdentity(ctx, {
          person,
          verifiedEmail: "owned@example.test",
          displayName: "New name",
          now: now + 1,
        });
      }),
    ).rejects.toThrow("already linked to another account");

    await expect(
      backend.run(async (ctx) => {
        const person = await ctx.db.get(fixture.personId);
        if (!person) throw new Error("Identity fixture is missing.");
        return refreshExistingPersonIdentity(ctx, {
          person,
          verifiedEmail: "event-owned@example.test",
          displayName: "New name",
          now: now + 2,
        });
      }),
    ).rejects.toThrow("belongs to another account in an event");

    const unchanged = await backend.run(async (ctx) => ({
      person: await ctx.db.get(fixture.personId),
      subject: await ctx.db.get(fixture.subjectId),
    }));
    expect(unchanged.person).toMatchObject({
      verifiedEmail: "old@example.test",
      displayName: "Person",
    });
    expect(unchanged.subject).toMatchObject({
      emailNormalized: "old@example.test",
      displayName: "Person",
      accessVersion: 1,
    });
  });
});

async function insertPerson(
  ctx: MutationCtx,
  verifiedEmail: string,
  now: number,
) {
  return ctx.db.insert("people", {
    authUserId: crypto.randomUUID(),
    googleSubject: crypto.randomUUID(),
    verifiedEmail,
    displayName: verifiedEmail === "old@example.test" ? "Person" : "Other",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}
