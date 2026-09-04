/** Internal barrel for the game/ folder: pure maze, timing, pickup, ghost and tick-reducer logic. No React, no I/O. */
export {
  CELL,
  MAZE,
  MAZE_COLS,
  MAZE_ROWS,
  NUM_GHOSTS,
  TELEPORTS,
  isWall,
  step,
  advance,
  tilesOf,
  key,
  PACMAN_SPAWN,
} from "./maze.ts";
export type { CellCode, Dir, Tile } from "./maze.ts";

export { FRIGHT, TICK_MS, scatter } from "./timing.ts";

export { SPEED, TURN_BUFFER } from "./speed.ts";

export { DOTS, EXTRA_LIFE_AT, FRUIT_AT, FRUIT_SPAWN, FRUIT_TICKS, POINTS, cleared, fruitOut } from "./pickups.ts";

export { GHOSTS, GHOST_HOUSE, GHOST_SPAWN, moveGhost, released } from "./ghosts.ts";
export type { Ghost } from "./ghosts.ts";

export { LIVES, NEW_GAME } from "./state.ts";
export type { Game } from "./state.ts";

export { tick } from "./tick.ts";
