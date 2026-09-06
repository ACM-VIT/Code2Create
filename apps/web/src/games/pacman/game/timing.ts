/**
 * Ticks per second, and the milliseconds per tick that follow from it.
 *
 * `SEC` is the primary constant, not derived: the arcade tables are in seconds
 * and the sim counts in ticks, so every duration below is `n * SEC`. Deriving it
 * back out of `TICK_MS` would give 59.999... and leave every one of those
 * durations a hair under a whole number of ticks, which countdowns compared
 * against 0 then never land on exactly.
 *
 * One tick is one frame, not one tile: every mover banks a fraction of a tile
 * per tick and steps once a whole tile is banked (see `speed.ts`). Running the
 * sim at frame rate is what lets Pac-Man, ghosts, tunnels and Elroy all move at
 * different speeds on a tile grid without jitter.
 */
export const SEC = 60;
export const TICK_MS = 1000 / SEC;

/** Level-1 mode phases in ticks, scatter first, alternating; chase forever after the last. */
const PHASES = [7, 20, 7, 20, 5, 20, 5].map((s) => s * SEC);

/** Frightened lasts 6s at level 1, flashing white for the last 2s. */
export const FRIGHT = { ticks: 6 * SEC, flash: 2 * SEC };

/** True while the scatter/chase clock (in ticks) sits in a scatter phase. */
export function scatter(t: number): boolean {
  let left = t;
  for (const [i, phase] of PHASES.entries()) {
    if (left < phase) return i % 2 === 0;
    left -= phase;
  }
  return false;
}
