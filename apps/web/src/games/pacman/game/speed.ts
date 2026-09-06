import { TELEPORTS, type Tile } from "./maze.ts";
import { TICK_MS } from "./timing.ts";
import { POINTS } from "./pickups.ts";

/**
 * Tiles moved per tick at 100% speed.
 *
 * The Pac-Man Dossier pins 100% at 75.7576 px/s over 8-px tiles, i.e. ~9.47
 * tiles/s; everything in `SPEED` is a percentage of this. `PACE` scales the
 * whole game (the arcade rate felt too quick on this board) without touching
 * the relative speeds.
 */
const PACE = 0.8 * 0.94;
const FULL = (75.7576 / 8) * (TICK_MS / 1000) * PACE;

/**
 * Level-1 movement speeds as percentages of `FULL` (Pac-Man Dossier, table A.1).
 *
 * The arcade's feel comes from the *relative* speeds: Pac-Man outruns the ghosts
 * on open track but a per-dot stop (`stall`) lets a chaser close in, ghosts crawl
 * through the tunnel, frightened ghosts are slow, and Blinky becomes "Cruise
 * Elroy" near the end.
 *  - `pacman` / `pacmanFright`: Pac-Man normally / while ghosts are frightened;
 *    both scaled by `PACMAN_BOOST` before use, so these stay the arcade's values.
 *  - `ghost`: any ghost on the open maze (also while leaving the house).
 *  - `tunnel`: a ghost within `TUNNEL_REACH` of a teleport mouth; Pac-Man is
 *    unaffected. Overrides everything but `eyes`.
 *  - `fright`: a frightened (edible) ghost. `eyes`: an eaten ghost racing home.
 *  - `elroy`: `[dotsLeft, speed]` pairs, most urgent first — Blinky's speed once
 *    at most that many dots remain, suspended after a death until Clyde is out.
 *  - `stall`: frames Pac-Man stops for per pellet / power pellet. This is what
 *    turns his 80% into the Dossier's "~71% on dots".
 */
export const SPEED = {
  pacman: 80,
  pacmanFright: 90,
  ghost: 75,
  tunnel: 40,
  fright: 50,
  eyes: 160,
  elroy: [[10, 85], [20, 80]] as const,
  stall: { [POINTS.pellet]: 1, [POINTS.power]: 3 } as Record<number, number>,
};

/** Percent of full speed -> tiles per tick. */
export const rate = (pct: number) => (pct / 100) * FULL;

/**
 * Pac-Man's own multiplier, on top of his `SPEED` percentages. At the Dossier's
 * 80% he reads as sluggish here; 7% is enough to feel responsive. Kept separate
 * so `SPEED` stays a faithful copy of the arcade table and this stays a visible,
 * revertable decision — the ghosts keep their arcade speeds, so this also widens
 * the gap he can open on a chaser.
 */
const PACMAN_BOOST = 1.07;

/** Tiles per tick for Pac-Man. Ghosts use plain `rate`. */
export const pacmanRate = (pct: number) => rate(pct) * PACMAN_BOOST;

/** Ticks to cross one dotted tile: a whole tile at his normal speed, plus the pellet stall. */
const TILE_TICKS = 1 / pacmanRate(SPEED.pacman) + (SPEED.stall[POINTS.pellet] ?? 0);

/**
 * How long (in ticks) a tapped direction stays live, waiting for a turn to open.
 *
 * Pac-Man only changes direction on a tile boundary, and those are `TILE_TICKS`
 * apart — asking the player to hit the key on the exact frame would be miserable.
 * Two tiles of travel: a turn is decided as he *leaves* a tile, so a press made
 * anywhere along the tile before a corner has to survive up to two boundaries.
 * Beyond it the press is dropped, so he carries straight on instead of veering
 * down some corridor the player asked for half a second ago. *Holding* a key
 * asks indefinitely — see `useGame`; this window is for a tap.
 */
export const TURN_BUFFER = Math.ceil(2 * TILE_TICKS);

/**
 * How far (in tiles, along the row) from a teleport mouth a ghost is still "in
 * the tunnel" and slowed to `SPEED.tunnel`. The arcade slows ghosts for the whole
 * side corridor; this map's corridors are short, so 2 covers the stretch before
 * the first side opening.
 */
const TUNNEL_REACH = 2;

/** Is this tile in a tunnel slow zone? See `TUNNEL_REACH`. */
export const tunnel = (t: Tile) =>
  TELEPORTS.some(({ endpoints }) => endpoints.some((e) => e.y === t.row && Math.abs(e.x - t.col) <= TUNNEL_REACH));
