/**
 * Arcade games and their leaderboard.
 *
 * A round is one finished play by one person. People replay as often as they
 * like, so every round is stored and the board ranks each person by their best
 * single round rather than by a total, which would reward volume over skill.
 * Standings are per person and never per team.
 *
 * The browser reports its own score. That is bounded by the published maximum
 * for the game and paced by a per-person rate limit, which keeps a casually
 * tampered round off the board; it is not a claim that the score is verified.
 *
 * Nothing here is specific to one game: a new entry in the domain catalogue is
 * playable through these functions without a schema or query change.
 */

import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { gameDefinition, gameRoundsPerMinute } from "@code2create/domain";
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

/**
 * How many rounds one board read walks. The scan is by descending score and
 * stops as soon as `leaderboardSize` distinct people are seen, so this only
 * binds the pathological case where a handful of people hold every top round.
 */
const leaderboardScanLimit = 500;

const leaderboardEntry = v.object({
  personId: v.id("people"),
  displayName: v.string(),
  bestScore: v.number(),
  playedAt: v.number(),
  isYou: v.boolean(),
});

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

/** The highest score `personId` has recorded for `gameKey`, or 0 when none. */
async function bestScoreFor(
  ctx: ReadCtx,
  eventId: Id<"events">,
  gameKey: string,
  personId: Id<"people">,
) {
  const best = await ctx.db
    .query("gameRounds")
    .withIndex("by_event_game_person", (index) =>
      index.eq("eventId", eventId).eq("gameKey", gameKey).eq("personId", personId),
    )
    .order("desc")
    .first();
  return best?.score ?? 0;
}

/**
 * Records one finished round.
 *
 * The round is kept whether or not it beats the person's previous best: the
 * board derives the best from the stored rounds, so a replay never overwrites
 * history.
 */
export const recordRound = mutation({
  args: { eventSlug: v.string(), gameKey: v.string(), score: v.number() },
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
    const paced = await gameRateLimiter.limit(ctx, "gameRound", { key: person._id });
    if (!paced.ok) {
      throw new ConvexError({
        code: "GAME_ROUNDS_TOO_FAST",
        message: "Too many rounds recorded just now. Play on and try again shortly.",
      });
    }

    await ctx.db.insert("gameRounds", {
      eventId: event._id,
      gameKey: game.key,
      personId: person._id,
      membershipId: membership._id,
      score: args.score,
      playedAt: Date.now(),
    });
    return { bestScore: await bestScoreFor(ctx, event._id, game.key, person._id) };
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

    const entries: {
      personId: Id<"people">;
      displayName: string;
      bestScore: number;
      playedAt: number;
      isYou: boolean;
    }[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    for await (const round of ctx.db
      .query("gameRounds")
      .withIndex("by_event_game_score", (index) =>
        index.eq("eventId", event._id).eq("gameKey", game.key),
      )
      .order("desc")) {
      scanned += 1;
      if (scanned > leaderboardScanLimit) break;
      if (seen.has(round.personId)) continue;
      seen.add(round.personId);
      const player = await ctx.db.get(round.personId);
      if (!player) continue;
      entries.push({
        personId: round.personId,
        displayName: player.displayName,
        bestScore: round.score,
        playedAt: round.playedAt,
        isYou: person !== null && person._id === round.personId,
      });
      if (entries.length >= leaderboardSize) break;
    }

    return {
      entries,
      yourBestScore: person
        ? await bestScoreFor(ctx, event._id, game.key, person._id)
        : 0,
    };
  },
});
