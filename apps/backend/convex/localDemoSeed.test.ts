import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import { readReviewParticipantAvailability } from "./lib/reviewParticipantAvailability.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);

const originalEnvironment = {
  seedEnabled: process.env.LOCAL_DEVELOPMENT_SEED_ENABLED,
  auth: process.env.AUTH_SITE_URL,
  participant: process.env.PARTICIPANT_SITE_URL,
  operations: process.env.OPERATIONS_SITE_URL,
  handbook: process.env.HANDBOOK_SITE_URL,
};

beforeAll(() => {
  process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "true";
  process.env.AUTH_SITE_URL = "http://localhost:3210";
  process.env.PARTICIPANT_SITE_URL = "http://localhost:5173";
  process.env.OPERATIONS_SITE_URL = "http://localhost:5174";
  process.env.HANDBOOK_SITE_URL = "http://localhost:5175";
});

afterAll(() => {
  process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = originalEnvironment.seedEnabled;
  process.env.AUTH_SITE_URL = originalEnvironment.auth;
  process.env.PARTICIPANT_SITE_URL = originalEnvironment.participant;
  process.env.OPERATIONS_SITE_URL = originalEnvironment.operations;
  process.env.HANDBOOK_SITE_URL = originalEnvironment.handbook;
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedBoth(backend: ReturnType<typeof seededBackend>) {
  await backend.mutation(api.localDevelopment.seedEvent, {
    confirmation: "seed-code2create-local",
  });
  return backend.action(api.localDemoSeed.seedDemoState, {
    confirmation: "seed-code2create-demo",
  });
}

test("the demo seed materialises a live event with teams across every queue state", async () => {
  const backend = seededBackend();
  const result = await seedBoth(backend);

  expect(result.teams).toBeGreaterThan(0);
  expect(result.reviewSessions).toBeGreaterThan(0);

  await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");
    expect(event.status).toBe("live");
    expect(event.startsAt).toBeLessThan(Date.now());
    expect(event.endsAt).toBeGreaterThan(Date.now());

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect();
    const confirmed = teams.filter((team) => team.status === "confirmed");
    expect(confirmed.length).toBe(result.teams);

    // `reviewOperations.roundBoard` reads this projection for every reviewable
    // team and throws when a row is missing, which would take down the board.
    for (const team of confirmed) {
      const availability = await readReviewParticipantAvailability(ctx, {
        eventId: event._id,
        teamId: team._id,
      });
      expect(availability.activeCount).toBeGreaterThan(0);
    }

    const states = await ctx.db.query("teamRoundStates").collect();
    expect(new Set(states.map((state) => state.state))).toEqual(
      new Set(["queued", "called", "in_review", "completed", "held"]),
    );
  });
});

test("teams are in the hall, and exactly one is held below the round minimum", async () => {
  const backend = seededBackend();
  await seedBoth(backend);

  await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");

    const availability = await ctx.db
      .query("attendanceTeamAvailability")
      .withIndex("by_event_team", (index) => index.eq("eventId", event._id))
      .collect();
    expect(availability.length).toBeGreaterThan(0);

    const shortHanded = availability.filter(
      (row) => row.insideMemberCount < row.activeMemberCount,
    );
    expect(shortHanded.length).toBe(1);
    expect(shortHanded[0]?.insideMemberCount).toBe(1);

    // Everyone else is fully present, so the desk can call them without a waiver.
    for (const row of availability) {
      if (row === shortHanded[0]) continue;
      expect(row.insideMemberCount).toBe(row.activeMemberCount);
    }
  });
});

test("running the demo seed twice changes nothing", async () => {
  const backend = seededBackend();
  await seedBoth(backend);

  const countRows = () =>
    backend.run(async (ctx) => ({
      people: (await ctx.db.query("people").collect()).length,
      teams: (await ctx.db.query("teams").collect()).length,
      roundStates: (await ctx.db.query("teamRoundStates").collect()).length,
      sessions: (await ctx.db.query("reviewSessions").collect()).length,
      scorecards: (await ctx.db.query("scorecards").collect()).length,
      grants: (await ctx.db.query("permissionGrants").collect()).length,
    }));

  const before = await countRows();
  await backend.action(api.localDemoSeed.seedDemoState, {
    confirmation: "seed-code2create-demo",
  });

  // The sentinel guard in each step is what makes `pnpm dev` safe to re-run.
  expect(await countRows()).toEqual(before);
});
