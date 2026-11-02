import { PAIR_COUNT } from "./engine.ts";

/**
 * Turning a finished board into the one number the arcade ranks.
 *
 * The game is really measured by two things that both get *better* as they get
 * smaller — moves taken and seconds spent — and the leaderboard ranks a single
 * score where bigger wins. So a round starts from a perfect board and spends
 * from it: every move past the twelve a flawless memory needs, and every second
 * on the clock, costs something.
 *
 * The floor exists so a slow finish still records as a finish. Nobody who
 * completed the board should be told they scored nothing.
 */
export const PERFECT_SCORE = 5_000;
const MOVE_COST = 40;
const SECOND_COST = 5;
export const MINIMUM_FINISHED_SCORE = 100;

/**
 * The clock is spent in milliseconds, not whole seconds.
 *
 * Two boards finished a fraction apart should not tie just because the second
 * hand had not moved between them, so the time cost is taken from the real
 * elapsed milliseconds and only the final score is rounded to the integer the
 * leaderboard stores.
 */
export function roundScore({
  moves,
  milliseconds,
}: {
  moves: number;
  milliseconds: number;
}): number {
  const extraMoves = Math.max(0, Math.floor(moves) - PAIR_COUNT);
  const timeCost = (Math.max(0, milliseconds) / 1_000) * SECOND_COST;
  const spent = extraMoves * MOVE_COST + timeCost;
  return Math.max(MINIMUM_FINISHED_SCORE, Math.round(PERFECT_SCORE - spent));
}
