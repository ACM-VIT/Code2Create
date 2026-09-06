import { PACMAN_SPAWN, type Dir, type Tile } from "./maze.ts";
import { GHOSTS, type Ghost } from "./ghosts.ts";

/** Three Pac-Men per game. */
export const LIVES = 3;

/** `eaten` holds dot keys; `t` is the tick count. */
export type Game = {
  pos: Tile;
  dir: Dir;
  /** Pac-Man's banked movement in tiles: he steps when it reaches 1. Goes negative after a dot (the arcade's per-dot stop). */
  acc: number;
  eaten: Set<string>;
  /** Ticks the fruit stays on the board; 0 = no fruit out. */
  fruit: number;
  /** Fruits that have appeared so far (eaten or timed out), indexing FRUIT_AT. */
  fruits: number;
  /** Ticks since the last dot, for the release timer. */
  idle: number;
  /** Ghosts let out by the release timer regardless of dots: indexes below this are released. */
  freed: number;
  ghosts: Ghost[];
  t: number;
  /** Scatter/chase clock in ticks: like `t` but paused while the ghosts are frightened, as the arcade does. */
  clock: number;
  score: number;
  /** Frightened ticks left; 0 = normal. */
  fright: number;
  /** Pac-Men left including the one in play; 0 = game over. */
  lives: number;
  /** Dots eaten at the last death, for the after-death release table. */
  since: number;
  /** The 10,000-point life has been awarded. */
  bonus: boolean;
  /** Ghosts eaten on the current power pellet: 200, 400, 800, 1600. */
  combo: number;
  /** A ghost was just eaten: the board freezes for `left` ticks showing `points` at `pos`. */
  bite: { pos: Tile; points: number; left: number } | null;
};

export const NEW_GAME: Game = {
  pos: PACMAN_SPAWN,
  dir: [0, 0],
  acc: 0,
  eaten: new Set(),
  fruit: 0,
  fruits: 0,
  idle: 0,
  freed: 0,
  ghosts: GHOSTS.map((g) => ({ pos: g.tile, dir: [0, 0], out: false, trail: [], mode: "normal", acc: 0 })),
  t: 0,
  clock: 0,
  score: 0,
  fright: 0,
  lives: LIVES,
  since: 0,
  bonus: false,
  combo: 0,
  bite: null,
};
