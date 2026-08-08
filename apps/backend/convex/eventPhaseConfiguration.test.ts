import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  normalizePhaseSchedule,
  publishPhaseSchedule,
  savePhaseScheduleDraft,
  type PhaseScheduleInput,
} from "./lib/phaseSchedule.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("event-phase configuration", () => {
  test("rejects missing and overlapping phase sets", () => {
    const complete = phases(Date.UTC(2027, 8, 10, 10));
    expect(() => normalizePhaseSchedule(complete.slice(0, 4))).toThrow(
      "one definition for each of the five event phases",
    );
    const overlapping = complete.map((phase) => ({ ...phase }));
    const build = overlapping[2];
    const ideation = overlapping[1];
    if (!build || !ideation) throw new Error("The fixture needs ideation and build phases.");
    build.startsAt = ideation.endsAt - 1;
    expect(() => normalizePhaseSchedule(overlapping)).toThrow("overlaps");
  });

  test("publishes the first complete schedule atomically", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const draft = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        phases: phases(fixture.phaseStart),
        now: fixture.now,
      }),
    );
    await backend.run((ctx) =>
      publishPhaseSchedule(ctx, {
        event: fixture.event,
        draftScheduleId: draft.scheduleVersionId,
        expectedDraftChecksum: draft.checksum,
        now: fixture.now + 1,
      }),
    );

    const state = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      const schedule = await ctx.db.get(draft.scheduleVersionId);
      const windows = await ctx.db
        .query("eventPhaseWindows")
        .withIndex("by_schedule_order", (index) =>
          index.eq("scheduleVersionId", draft.scheduleVersionId),
        )
        .collect();
      return {
        eventVersion: event?.version,
        publishedScheduleId: event?.publishedEventPhaseScheduleId,
        scheduleStatus: schedule?.status,
        phaseStatuses: windows.map((window) => window.status),
      };
    });
    expect(state).toEqual({
      eventVersion: 2,
      publishedScheduleId: draft.scheduleVersionId,
      scheduleStatus: "published",
      phaseStatuses: Array.from({ length: 5 }, () => "published"),
    });
  });

  test("allows only one competing first draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const first = saveDraft(backend, fixture, "First");
    const second = saveDraft(backend, fixture, "Second");
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const state = await backend.run(async (ctx) =>
      ctx.db
        .query("eventPhaseScheduleVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(state).toHaveLength(1);
  });

  test("rejects publication of a replaced draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const first = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        phases: phases(fixture.phaseStart, "First"),
        now: fixture.now,
      }),
    );
    const second = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        phases: phases(fixture.phaseStart, "Second"),
        expectedDraftScheduleId: first.scheduleVersionId,
        now: fixture.now + 1,
      }),
    );
    await expect(
      backend.run((ctx) =>
        publishPhaseSchedule(ctx, {
          event: fixture.event,
          draftScheduleId: first.scheduleVersionId,
          expectedDraftChecksum: first.checksum,
          now: fixture.now + 2,
        }),
      ),
    ).rejects.toThrow("changed in another session");
    const state = await backend.run(async (ctx) => ({
      first: await ctx.db.get(first.scheduleVersionId),
      second: await ctx.db.get(second.scheduleVersionId),
    }));
    expect(state.first?.status).toBe("retired");
    expect(state.second?.status).toBe("draft");
  });

  test("does not rewrite a completed phase", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await publishedFixture(backend);
    const replacement = phases(fixture.phaseStart);
    const introduction = replacement[0];
    if (!introduction) throw new Error("The fixture needs an introduction phase.");
    introduction.description = "A rewritten introduction after it already ended.";
    const event = await requireEvent(backend, fixture.eventId);
    const draft = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event,
        actorPersonId: fixture.personId,
        phases: replacement,
        now: fixture.phaseStart + 90 * 60_000,
      }),
    );
    await expect(
      backend.run((ctx) =>
        publishPhaseSchedule(ctx, {
          event,
          draftScheduleId: draft.scheduleVersionId,
          expectedDraftChecksum: draft.checksum,
          now: fixture.phaseStart + 90 * 60_000,
        }),
      ),
    ).rejects.toThrow("has ended and cannot be rewritten");
  });

  test("changes a current end and future phases without rewriting history", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await publishedFixture(backend);
    const replacement = phases(fixture.phaseStart);
    const ideation = replacement[1];
    const build = replacement[2];
    const intermediate = replacement[3];
    const final = replacement[4];
    if (!ideation || !build || !intermediate || !final) {
      throw new Error("The fixture needs every future phase.");
    }
    ideation.endsAt += 30 * 60_000;
    build.startsAt += 30 * 60_000;
    build.endsAt += 30 * 60_000;
    build.description = "The adjusted main hacking window.";
    intermediate.startsAt += 30 * 60_000;
    intermediate.endsAt += 30 * 60_000;
    final.startsAt += 30 * 60_000;
    final.endsAt += 30 * 60_000;
    const event = await requireEvent(backend, fixture.eventId);
    const now = fixture.phaseStart + 90 * 60_000;
    const draft = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event,
        actorPersonId: fixture.personId,
        phases: replacement,
        now,
      }),
    );
    await backend.run((ctx) =>
      publishPhaseSchedule(ctx, {
        event,
        draftScheduleId: draft.scheduleVersionId,
        expectedDraftChecksum: draft.checksum,
        now,
      }),
    );
    const state = await backend.run(async (ctx) => {
      const nextEvent = await ctx.db.get(fixture.eventId);
      const previous = await ctx.db.get(fixture.scheduleId);
      const current = await ctx.db.get(draft.scheduleVersionId);
      return {
        publishedScheduleId: nextEvent?.publishedEventPhaseScheduleId,
        previousStatus: previous?.status,
        currentStatus: current?.status,
      };
    });
    expect(state).toEqual({
      publishedScheduleId: draft.scheduleVersionId,
      previousStatus: "superseded",
      currentStatus: "published",
    });
  });
});

function phases(start: number, suffix = ""): PhaseScheduleInput[] {
  const names = [
    ["introduction", "Introduction", "Welcome, orientation, and event setup."],
    ["ideation", "Ideation", "Teams refine the problem, users, and approach."],
    ["build", "Build", "The main hacking window."],
    ["intermediate_update", "Intermediate update", "Teams record a progress checkpoint."],
    ["final_update", "Final update", "Teams complete the final project checkpoint."],
  ] as const satisfies readonly (readonly [PhaseScheduleInput["phaseKey"], string, string])[];
  return names.map(([phaseKey, displayName, description], index) => ({
    phaseKey,
    displayName: suffix ? `${displayName} ${suffix}` : displayName,
    description,
    startsAt: start + index * 60 * 60_000,
    endsAt: start + (index + 1) * 60 * 60_000,
  }));
}

async function saveDraft(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  suffix: string,
) {
  return backend.run((ctx) =>
    savePhaseScheduleDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      phases: phases(fixture.phaseStart, suffix),
      now: fixture.now,
    }),
  );
}

async function publishedFixture(backend: BackendTest) {
  const fixture = await seedFixture(backend);
  const draft = await backend.run((ctx) =>
    savePhaseScheduleDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      phases: phases(fixture.phaseStart),
      now: fixture.now,
    }),
  );
  await backend.run((ctx) =>
    publishPhaseSchedule(ctx, {
      event: fixture.event,
      draftScheduleId: draft.scheduleVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 1,
    }),
  );
  return {
    ...fixture,
    eventId: fixture.event._id,
    scheduleId: draft.scheduleVersionId,
  };
}

async function requireEvent(backend: BackendTest, eventId: Id<"events">) {
  const event = await backend.run((ctx) => ctx.db.get(eventId));
  if (!event) throw new Error("The event fixture is missing.");
  return event;
}

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 8, 10, 8);
  const phaseStart = now + 60 * 60_000;
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `phase-config-user-${now}`,
      googleSubject: `phase-config-subject-${now}`,
      verifiedEmail: `phase-config-${now}@example.test`,
      displayName: "Mira Shah",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `phase-config-${now}`,
      name: "Code2Create phase configuration fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The event fixture did not persist.");
    return { event, personId, now, phaseStart };
  });
}
