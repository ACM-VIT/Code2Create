/**
 * Arcade games and their leaderboard.
 *
 * A round is one finished play by one person. People replay as often as they
 * like, so every round is stored and the board ranks each person by their best
 * single round rather than by a total, which would reward volume over skill.
 * Standings are per person and never per team.
 *
 * The browser reports its own score, so a round is reported against a run the
 * server opened: the score is bounded by the published maximum, held to what
 * the game could plausibly have scored in the time the run was actually open,
 * spendable once, and paced by a per-person rate limit. Together those make a
 * forged score cost the time it claims to have taken instead of being free.
 * None of it verifies the play itself — only a server-side simulation of the
 * round would — so this is a bar, not a proof.
 *
 * Nothing here is specific to one game: a new entry in the domain catalogue is
 * playable through these functions without a schema or query change.
 */

import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import {
  gameDefinition,
  gameRoundsPerMinute,
  gameRunLifetimeMs,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireMembership,
} from "./lib/identity";

type ReadCtx = QueryCtx | MutationCtx;

const gameRateLimiter = new RateLimiter(components.gameRateLimiter, {
  gameRound: { kind: "fixed window", rate: gameRoundsPerMinute, period: MINUTE },
});

/** How many people the board shows. */
const leaderboardSize = 20;

const leaderboardEntry = v.object({
  personId: v.id("people"),
  displayName: v.string(),
  bestScore: v.number(),
  playedAt: v.number(),
  isYou: v.boolean(),
});

const vitRegistrationNumberPattern =
  /\s*(?:[-–—|·]\s*)?[([]?\b\d{2}\s*[a-z]{3}\s*\d{4}\b[\])]?\s*/giu;

/** Registration numbers sometimes arrive inside a person's profile name. */
export function publicLeaderboardName(displayName: string) {
  const name = displayName
    .replace(vitRegistrationNumberPattern, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-–—|·]\s*)+|(?:\s*[-–—|·])+$/gu, "");
  return name || "Player";
}

/** The published game for `key`, or a client error when the key is unknown. */
function requireGame(key: string) {
  const game = gameDefinition(key);
  if (!game) {
    throw new ConvexError({
      code: "UNKNOWN_GAME",
      message: "That game is not published for this event.",
    });
  }
  return game;
}

/** One person's standing row for `gameKey`, or null before their first round. */
async function personBest(
  ctx: ReadCtx,
  eventId: Id<"events">,
  gameKey: string,
  personId: Id<"people">,
) {
  return await ctx.db
    .query("gamePersonBests")
    .withIndex("by_event_game_person", (index) =>
      index.eq("eventId", eventId).eq("gameKey", gameKey).eq("personId", personId),
    )
    .unique();
}

/**
 * Opens a run and returns its id, to be handed back when the round ends.
 *
 * The stamp is taken here, on the server, so the elapsed time a reported score
 * is judged against is one the browser cannot choose.
 */
export const startRound = mutation({
  args: { eventSlug: v.string(), gameKey: v.string() },
  returns: v.object({ runId: v.id("gameRuns") }),
  handler: async (ctx, args) => {
    const game = requireGame(args.gameKey);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    requireEligibleMembership(await requireMembership(ctx, event._id, person._id));
    const paced = await gameRateLimiter.limit(ctx, "gameRound", { key: person._id });
    if (!paced.ok) {
      throw new ConvexError({
        code: "GAME_ROUNDS_TOO_FAST",
        message: "Too many rounds started just now. Play on and try again shortly.",
      });
    }
    const runId = await ctx.db.insert("gameRuns", {
      eventId: event._id,
      gameKey: game.key,
      personId: person._id,
      startedAt: Date.now(),
    });
    return { runId };
  },
});

/**
 * Records one finished round against the run it was played in.
 *
 * The round is kept whether or not it beats the person's previous best: a
 * replay never overwrites history, and the person's standing row moves only
 * when the round actually beats it.
 */
export const recordRound = mutation({
  args: {
    eventSlug: v.string(),
    gameKey: v.string(),
    score: v.number(),
    runId: v.id("gameRuns"),
  },
  returns: v.object({ bestScore: v.number() }),
  handler: async (ctx, args) => {
    const game = requireGame(args.gameKey);
    if (!Number.isSafeInteger(args.score) || args.score < 0 || args.score > game.maximumScore) {
      throw new ConvexError({
        code: "INVALID_GAME_SCORE",
        message: `A ${game.title} round scores a whole number from 0 through ${game.maximumScore}.`,
      });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    // Pacing is enforced when the run is opened, not here: a report needs an
    // unspent run, so rationing runs already rations reports. Charging both
    // would cost a round two of the person's allowance instead of one.

    // The run is what makes the reported score cost something: it belongs to
    // this person and this game, it is spent once, and it carries a server
    // stamp the browser never saw.
    const now = Date.now();
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.personId !== person._id ||
      run.eventId !== event._id ||
      run.gameKey !== game.key
    ) {
      throw new ConvexError({
        code: "GAME_RUN_NOT_FOUND",
        message: "That round is not one of your open runs. Start a new game.",
      });
    }
    if (run.consumedAt !== undefined) {
      throw new ConvexError({
        code: "GAME_RUN_ALREADY_RECORDED",
        message: "That round has already been recorded. Start a new game.",
      });
    }
    const elapsedMs = now - run.startedAt;
    if (elapsedMs > gameRunLifetimeMs) {
      throw new ConvexError({
        code: "GAME_RUN_EXPIRED",
        message: "That game sat open too long to record. Start a new one.",
      });
    }
    // A score is only as good as the time there was to earn it: no run can
    // report more than the game's fastest plausible scoring rate allows.
    if (args.score > (elapsedMs / 1000) * game.maximumScorePerSecond) {
      throw new ConvexError({
        code: "IMPLAUSIBLE_GAME_SCORE",
        message: "That score is higher than the round had time to earn.",
      });
    }
    await ctx.db.patch(run._id, { consumedAt: now });

    await ctx.db.insert("gameRounds", {
      eventId: event._id,
      gameKey: game.key,
      personId: person._id,
      membershipId: membership._id,
      score: args.score,
      playedAt: now,
    });

    // The standing row carries the person's best round, so the board never has
    // to skip repeats. A round that does not beat it leaves it untouched.
    const standing = await personBest(ctx, event._id, game.key, person._id);
    if (!standing) {
      await ctx.db.insert("gamePersonBests", {
        eventId: event._id,
        gameKey: game.key,
        personId: person._id,
        bestScore: args.score,
        achievedAt: now,
      });
      return { bestScore: args.score };
    }
    if (args.score > standing.bestScore) {
      await ctx.db.patch(standing._id, { bestScore: args.score, achievedAt: now });
      return { bestScore: args.score };
    }
    return { bestScore: standing.bestScore };
  },
});

/**
 * The board for one game: each person once, by their best round, highest first.
 *
 * Signed-out and non-participant readers get the board without a `isYou` mark
 * rather than an error, so the standings stay readable from the game screen
 * while a person is still joining the event.
 */
export const leaderboard = query({
  args: { eventSlug: v.string(), gameKey: v.string() },
  returns: v.object({
    entries: v.array(leaderboardEntry),
    yourBestScore: v.number(),
  }),
  handler: async (ctx, args) => {
    const game = requireGame(args.gameKey);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await findCurrentPerson(ctx);

    // One row per person, so the top `leaderboardSize` rows are the top
    // `leaderboardSize` people. No repeat rows to skip and nothing to truncate:
    // however often one person replays, they occupy exactly one row.
    const standings = await ctx.db
      .query("gamePersonBests")
      .withIndex("by_event_game_score", (index) =>
        index.eq("eventId", event._id).eq("gameKey", game.key),
      )
      .order("desc")
      .take(leaderboardSize);

    const entries: {
      personId: Id<"people">;
      displayName: string;
      bestScore: number;
      playedAt: number;
      isYou: boolean;
    }[] = [];
    for (const standing of standings) {
      const player = await ctx.db.get(standing.personId);
      if (!player) continue;
      entries.push({
        personId: standing.personId,
        displayName: publicLeaderboardName(player.displayName),
        bestScore: standing.bestScore,
        playedAt: standing.achievedAt,
        isYou: person !== null && person._id === standing.personId,
      });
    }

    return {
      entries,
      yourBestScore: person
        ? ((await personBest(ctx, event._id, game.key, person._id))?.bestScore ?? 0)
        : 0,
    };
  },
});
