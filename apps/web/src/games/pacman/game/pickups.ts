import { CELL, key, tilesOf, type Tile } from "./maze.ts";
import { SEC } from "./timing.ts";
import type { Game } from "./state.ts";

/** Every dot on the board: a pellet on each PATH tile, a power pellet on each POWER_PELLET tile. */
export const DOTS = {
  pellets: tilesOf(CELL.PATH),
  power: tilesOf(CELL.POWER_PELLET),
};

/**
 * Fruit slot below the ghost house, beside the ghost-spawn marker: a cherry (the
 * only fruit, there's one level), appearing when the 70th and 170th dots are eaten.
 * Must be a PATH tile, so the cherry sits on a dot and can be walked onto.
 */
export const FRUIT_SPAWN: Tile = { row: 18, col: 12 };
export const FRUIT_AT = [70, 170];

/** The fruit leaves the board after 9s if it isn't eaten. */
export const FRUIT_TICKS = 9 * SEC;

/** Arcade points for level 1. */
export const POINTS = { pellet: 10, power: 50, cherry: 100, ghost: 200 };
/** One bonus life at 10,000 points. */
export const EXTRA_LIFE_AT = 10_000;

/** Dot key -> points. */
export const DOT_KEYS = new Map([
  ...DOTS.pellets.map((t) => [key(t), POINTS.pellet] as const),
  ...DOTS.power.map((t) => [key(t), POINTS.power] as const),
]);

export const fruitOut = (g: Game) => g.fruit > 0;

/** Every dot eaten: the one level is done. */
export const cleared = (g: Game) => g.eaten.size === DOT_KEYS.size;
