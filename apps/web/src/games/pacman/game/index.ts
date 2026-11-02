/** Internal barrel for the game/ folder: pure maze, timing, pickup, ghost and tick-reducer logic. No React, no I/O. */
export { CELL, MAZE, MAZE_COLS, MAZE_ROWS, TELEPORTS, isWall, cellAt, key } from "./maze.ts";
export type { Dir, Tile } from "./maze.ts";

export { FRIGHT, TICK_MS } from "./timing.ts";

export { TURN_BUFFER } from "./speed.ts";

export { DOTS, FRUIT_SPAWN, cleared, fruitOut } from "./pickups.ts";

export { ghostDef } from "./ghosts.ts";

export { NEW_GAME } from "./state.ts";
export type { Game } from "./state.ts";

export { tick } from "./tick.ts";
