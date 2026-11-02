import { MAZE_COLS, MAZE_ROWS, house, key, step, type Dir, type Tile } from "./maze.ts";
import { SEC } from "./timing.ts";
import type { Game } from "./state.ts";

/**
 * Arcade ghosts. `tile`: start (all inside the house), `door`: the tile they
 * head for to get out, `corner`: scatter target (Blinky TR, Pinky TL, Inky BR, Clyde BL).
 *
 * Each pocket holds its pair on one row, on cols 11 and 13: one against the
 * pocket's closed wall, the other a block further in with a gap between them. Both
 * pockets use the same two columns, so the four line up as two vertical rows.
 * A pocket's two ghosts must stay in
 * different columns — a waiting ghost bobs half a tile towards the pocket's other
 * row, so a shared column would have them drift into each other.
 *
 * Within a pocket the one released first sits nearer the door: Blinky before
 * Pinky (0 and 7 dots after a death), Inky before Clyde (30 and 60). Seated the
 * other way round the earlier ghost has to walk through its pocket-mate's tile on
 * the way out, and ghosts do not collide, so it would visibly pass through it.
 */
export type GhostDef = { name: string; tile: Tile; door: Tile; corner: Tile };

export const GHOSTS: readonly GhostDef[] = [
  { name: "blinky", tile: { row: 8, col: 10 }, door: { row: 8, col: 8 }, corner: { row: 0, col: MAZE_COLS - 1 } },
  { name: "pinky", tile: { row: 8, col: 12 }, door: { row: 8, col: 8 }, corner: { row: 0, col: 0 } },
  { name: "inky", tile: { row: 11, col: 12 }, door: { row: 11, col: 14 }, corner: { row: MAZE_ROWS - 1, col: MAZE_COLS - 1 } },
  { name: "clyde", tile: { row: 11, col: 10 }, door: { row: 11, col: 14 }, corner: { row: MAZE_ROWS - 1, col: 0 } },
];

/** Ghost `i`'s fixed facts. A game's ghost list is built from `GHOSTS`, so its indexes always resolve. */
export function ghostDef(i: number): GhostDef {
  const def = GHOSTS[i];
  if (!def) throw new Error(`no ghost ${i}`);
  return def;
}

/**
 * `out`: has left the ghost house. `trail`: keys of the last few tiles, avoided so 2-wide corridors don't trap it in a loop.
 * `mode`: `scared` after a power pellet, `eyes` once eaten (running home to regenerate).
 * `acc`: banked movement in tiles (0..1) — each tick adds this ghost's `SPEED` rate and it steps once a whole tile is banked.
 */
export type Ghost = { pos: Tile; dir: Dir; out: boolean; trail: string[]; mode: "normal" | "scared" | "eyes"; acc: number };

/** Dots eaten before each ghost leaves the house (level 1). */
const RELEASE = [0, 0, 30, 60];
/** After a death the arcade counts dots from the reset instead, with these thresholds. */
const RELEASE_AFTER_DEATH = [0, 7, 17, 32];
/** Level-1 arcade: 4s without a dot lets the next ghost out anyway. */
export const RELEASE_IDLE = 4 * SEC;
/** Ghost `i` exists once its release count is met or the no-dot timer freed it; before that it's not on the board at all. */
export const released = (g: Game, i: number) =>
  i < g.freed || g.eaten.size - g.since >= ((g.since ? RELEASE_AFTER_DEATH : RELEASE)[i] ?? Infinity); // a death at 0 dots leaves `since` at 0, so the start table still applies

/** Arcade tie-break order when two directions are equally close to the target. */
const DIRS: Dir[] = [[-1, 0], [0, -1], [1, 0], [0, 1]];
const dist2 = (a: Tile, b: Tile) => (a.row - b.row) ** 2 + (a.col - b.col) ** 2;
const ahead = (g: Game, n: number): Tile => ({ row: g.pos.row + g.dir[0] * n, col: g.pos.col + g.dir[1] * n });

/** Chase targets, indexed like GHOSTS. Unlike the arcade, Pinky and Inky omit its facing-up overflow bug. */
export const TARGET: ((g: Game) => Tile)[] = [
  (g) => g.pos,
  (g) => ahead(g, 4),
  (g) => {
    const a = ahead(g, 2);
    const b = g.ghosts[0]?.pos ?? g.pos;
    return { row: 2 * a.row - b.row, col: 2 * a.col - b.col };
  },
  (g) => {
    const clyde = g.ghosts[3];
    return !clyde || dist2(g.pos, clyde.pos) > 64 ? g.pos : ghostDef(3).corner;
  },
];

/** Tiles remembered per ghost: 4 covers a lap of a 2x2 block, the smallest loop on this map. */
const TRAIL = 4;

/**
 * Arcade ghost step: never reverse, take the open neighbour closest (straight
 * line) to `target`, ties broken up > left > down > right. A ghost that's out
 * may not re-enter the house. `target: null` is frightened: a random open
 * direction instead. Non-arcade: tiles in `trail` are taken only if nothing
 * else is open.
 *
 * The mode-change reversal happens in `tick`, which flips `dir` before banking
 * this ghost's speed — so a reversal costs a tile of travel like any other step.
 */
export function moveGhost(g: Ghost, target: Tile | null): Ghost {
  const dir: Dir = g.dir;
  const open = DIRS.flatMap((d) => {
    if (d[0] === -dir[0] && d[1] === -dir[1]) return [];
    const pos = step(g.pos.row, g.pos.col, d[0], d[1], !g.out);
    return pos ? [{ pos, dir: d, fresh: !g.trail.includes(key(pos)) }] : [];
  });
  const first = open[0];
  if (!first) return { ...g, dir }; // boxed in: turn around, move next tick
  let best = open[Math.floor(Math.random() * open.length)] ?? first;
  if (target)
    for (const c of open) {
      const better = (c.fresh && !best.fresh) || (c.fresh === best.fresh && dist2(c.pos, target) < dist2(best.pos, target));
      if (c === first || better) best = c;
    }
  const trail = [key(g.pos), ...g.trail].slice(0, TRAIL);
  return { ...g, pos: best.pos, dir: best.dir, out: g.out || !house(best.pos), trail };
}

/** Next tile on a shortest path (BFS, house allowed). Eyes path-find because greedy steering loops on this map's side-opening house. */
function towards(from: Tile, to: Tile): Tile | null {
  const prev = new Map<string, Tile | null>([[key(from), null]]);
  const queue = [from];
  // `for...of` reads the array live, so tiles pushed during the walk are visited too.
  for (const t of queue) {
    if (key(t) === key(to)) {
      let cur = t;
      let back = prev.get(key(cur));
      while (back && key(back) !== key(from)) {
        cur = back;
        back = prev.get(key(cur));
      }
      return cur;
    }
    for (const d of DIRS) {
      const n = step(t.row, t.col, d[0], d[1], true);
      if (n && !prev.has(key(n))) { prev.set(key(n), t); queue.push(n); }
    }
  }
  return null;
}

/**
 * One step of an eaten ghost's run home; it regenerates on its start tile and
 * leaves the house again unfrightened. Speed comes from `SPEED.eyes` in `tick`,
 * which only calls this once a whole tile is banked.
 */
export function goHome(gh: Ghost, i: number): Ghost {
  const home = ghostDef(i).tile;
  if (key(gh.pos) === key(home)) return { ...gh, mode: "normal", out: false, trail: [] };
  const pos = towards(gh.pos, home) ?? gh.pos;
  return { ...gh, pos, dir: [Math.sign(pos.row - gh.pos.row), Math.sign(pos.col - gh.pos.col)] };
}
