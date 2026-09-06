import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema.ts";
import { publicLeaderboardName } from "./games";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

/** Pac-Man's published bound, and the rate a round is held to. */
const maximumScore = 20_830;
const maximumScorePerSecond = 750;

describe("games leaderboard", () => {
  test("removes VIT registration numbers from public names", () => {
    expect(publicLeaderboardName("Ishaan Deepak Samdani 23BME0453")).toBe(
      "Ishaan Deepak Samdani",
    );
    expect(publicLeaderboardName("ISHITA JOSHI (24BEL0054)")).toBe("ISHITA JOSHI");
    expect(publicLeaderboardName("25 BCE2114 - Avni Jain")).toBe("Avni Jain");
    expect(publicLeaderboardName("23BME0453")).toBe("Player");
  });

  test("ranks people rather than rounds, however often one person replays", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 3);
    const [heavy, second, third] = fixture.players;
    if (!heavy || !second || !third) throw new Error("The fixture is short of players.");

    // The replay-heavy player records more rounds than the board is wide, every
    // one higher than anyone else's. Ranking rounds would let these fill the
    // board; ranking people gives them exactly one row.
    for (let round = 0; round < 25; round += 1) {
      await recordRound(backend, fixture, heavy, 5_000 + round);
    }
    await recordRound(backend, fixture, second, 900);
    await recordRound(backend, fixture, third, 800);

    const board = await backend.query(api.games.leaderboard, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    expect(board.entries).toHaveLength(3);
    expect(board.entries.map((entry) => entry.bestScore)).toEqual([5_024, 900, 800]);
    // Everyone appears once, and the replays did not hide the other players.
    expect(new Set(board.entries.map((entry) => entry.personId)).size).toBe(3);
  });

  test("keeps a person's best round when a later round is worse", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 1);
    const [player] = fixture.players;
    if (!player) throw new Error("The fixture has no player.");

    expect(await recordRound(backend, fixture, player, 4_000)).toMatchObject({
      bestScore: 4_000,
    });
    expect(await recordRound(backend, fixture, player, 10)).toMatchObject({
      bestScore: 4_000,
    });

    const board = await backend.query(api.games.leaderboard, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]?.bestScore).toBe(4_000);
  });

  test("refuses a score the round had no time to earn", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 1);
    const [player] = fixture.players;
    if (!player) throw new Error("The fixture has no player.");
    const as = identity(backend, player);

    // The forged submission: open a run and immediately claim the maximum.
    const { runId } = await as.mutation(api.games.startRound, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    await expect(
      as.mutation(api.games.recordRound, {
        eventSlug: fixture.eventSlug,
        gameKey: "pacman",
        score: maximumScore,
        runId,
      }),
    ).rejects.toThrow("higher than the round had time to earn");

    // Nothing was written, so the board stays empty.
    const board = await backend.query(api.games.leaderboard, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    expect(board.entries).toEqual([]);
  });

  test("accepts the same score once the round has run long enough", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 1);
    const [player] = fixture.players;
    if (!player) throw new Error("The fixture has no player.");
    const as = identity(backend, player);

    const { runId } = await as.mutation(api.games.startRound, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    // Age the run past the time a maximum round needs at the fastest rate the
    // game can score, which is what the mutation holds the report against.
    await ageRun(backend, runId, maximumScore);
    expect(
      await as.mutation(api.games.recordRound, {
        eventSlug: fixture.eventSlug,
        gameKey: "pacman",
        score: maximumScore,
        runId,
      }),
    ).toMatchObject({ bestScore: maximumScore });
  });

  test("spends a run once", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 1);
    const [player] = fixture.players;
    if (!player) throw new Error("The fixture has no player.");
    const as = identity(backend, player);

    const { runId } = await as.mutation(api.games.startRound, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    await ageRun(backend, runId, 100);
    await as.mutation(api.games.recordRound, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
      score: 100,
      runId,
    });
    await expect(
      as.mutation(api.games.recordRound, {
        eventSlug: fixture.eventSlug,
        gameKey: "pacman",
        score: 100,
        runId,
      }),
    ).rejects.toThrow("already been recorded");
  });

  test("refuses a run opened by someone else", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, 2);
    const [owner, thief] = fixture.players;
    if (!owner || !thief) throw new Error("The fixture is short of players.");

    const { runId } = await identity(backend, owner).mutation(api.games.startRound, {
      eventSlug: fixture.eventSlug,
      gameKey: "pacman",
    });
    await ageRun(backend, runId, 100);
    await expect(
      identity(backend, thief).mutation(api.games.recordRound, {
        eventSlug: fixture.eventSlug,
        gameKey: "pacman",
        score: 100,
        runId,
      }),
    ).rejects.toThrow("not one of your open runs");
  });
});

type Player = { authUserId: string; authSessionId: string };
type Fixture = { eventSlug: string; players: Player[] };

function seededBackend() {
  const backend = convexTest({ schema, modules });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(backend, "gameRateLimiter");
  return backend;
}

function identity(backend: BackendTest, player: Player) {
  return backend.withIdentity({
    subject: player.authUserId,
    sessionId: player.authSessionId,
  });
}

/**
 * Backdate a run so `score` is plausible for the time it was open. Tests want
 * the round's outcome, not to sit through the seconds it would really take.
 */
async function ageRun(backend: BackendTest, runId: Id<"gameRuns">, score: number) {
  await backend.run(async (ctx) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("The run was not opened.");
    await ctx.db.patch(runId, {
      startedAt: run.startedAt - (score / maximumScorePerSecond) * 1000 - 1_000,
    });
  });
}

/** One finished round, through the run the server opened for it. */
async function recordRound(
  backend: BackendTest,
  fixture: Fixture,
  player: Player,
  score: number,
) {
  const as = identity(backend, player);
  const { runId } = await as.mutation(api.games.startRound, {
    eventSlug: fixture.eventSlug,
    gameKey: "pacman",
  });
  await ageRun(backend, runId, score);
  return await as.mutation(api.games.recordRound, {
    eventSlug: fixture.eventSlug,
    gameKey: "pacman",
    score,
    runId,
  });
}

async function seedFixture(backend: BackendTest, playerCount: number) {
  const now = Date.now();
  const eventSlug = `games-${crypto.randomUUID()}`;
  const accounts: (Player & { email: string; name: string })[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    accounts.push(await insertAccount(backend, `player-${index}`, now));
  }
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Games fixture",
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
    const players: Player[] = [];
    for (const account of accounts) {
      const personId = await ctx.db.insert("people", {
        authUserId: account.authUserId,
        verifiedEmail: account.email,
        displayName: account.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: account.email,
        displayName: account.name,
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
      players.push({ authUserId: account.authUserId, authSessionId: account.authSessionId });
    }
    return { eventSlug, players } satisfies Fixture;
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
  return {
    email,
    name,
    authUserId,
    authSessionId: documentId(session, "Better Auth session"),
  };
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
