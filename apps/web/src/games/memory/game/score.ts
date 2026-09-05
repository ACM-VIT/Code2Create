import { PERFECT_MOVES } from "./engine.ts";

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
export const MOVE_COST = 40;
export const SECOND_COST = 5;
export const MINIMUM_FINISHED_SCORE = 100;

export function roundScore({ moves, seconds }: { moves: number; seconds: number }): number {
  const extraMoves = Math.max(0, Math.floor(moves) - PERFECT_MOVES);
  const spent = extraMoves * MOVE_COST + Math.max(0, Math.floor(seconds)) * SECOND_COST;
  return Math.max(MINIMUM_FINISHED_SCORE, PERFECT_SCORE - spent);
}
