import { PACMAN_SPAWN, advance, key, type Dir } from "./maze.ts";
import { FRIGHT, SEC, scatter } from "./timing.ts";
import { SPEED, pacmanRate, rate, tunnel } from "./speed.ts";
import { DOT_KEYS, EXTRA_LIFE_AT, FRUIT_AT, FRUIT_SPAWN, FRUIT_TICKS, POINTS, cleared, fruitOut } from "./pickups.ts";
import { GHOSTS, RELEASE_IDLE, TARGET, goHome, moveGhost, released } from "./ghosts.ts";
import { NEW_GAME, type Game } from "./state.ts";

/**
 * Arcade contact for ghost `i`: it ends the tick on Pac-Man's tile, or the two
 * crossed head-on and swapped tiles without ever sharing one. The swap test
 * needs both endpoints, hence the pre- and post-move states.
 */
function met(before: Game, after: Game, i: number): boolean {
  const gh = after.ghosts[i]!;
  if (key(gh.pos) === key(after.pos)) return true;
  const was = before.ghosts[i]!.pos;
  return key(gh.pos) === key(before.pos) && key(was) === key(after.pos);
}

/**
 * One frame of the game. Pac-Man and each ghost bank their own speed into `acc`
 * and step a tile only once a whole one is banked, so everything moves at its
 * own rate on a shared tile grid: eat whatever he landed on, move the ghosts,
 * then check for a bite or a death.
 */
export function tick(g: Game, want: Dir): Game {
  if (!g.lives || cleared(g)) return g; // game over or completed
  if (g.bite) return { ...g, bite: g.bite.left > 1 ? { ...g.bite, left: g.bite.left - 1 } : null }; // everything freezes, fright clock included
  const pace = pacmanRate(g.fright ? SPEED.pacmanFright : SPEED.pacman);
  let acc = g.acc + pace, pos = g.pos, dir = g.dir;
  if (acc >= 1) {
    ({ pos, dir } = advance(g.pos, want, g.dir));
    acc = key(pos) === key(g.pos) ? 1 : acc - 1; // blocked: stay primed so a new key moves him at once
  }
  const k = key(pos);
  const dot = g.eaten.has(k) ? 0 : (DOT_KEYS.get(k) ?? 0);
  const eaten = dot ? new Set(g.eaten).add(k) : g.eaten;
  if (dot) acc -= (SPEED.stall[dot] ?? 0) * pace; // the arcade stops Pac-Man for a frame per dot, three per power pellet
  const cherry = fruitOut(g) && k === key(FRUIT_SPAWN);
  // The fruit counts down while out; the next one appears once its dot trigger is reached and no fruit is out.
  let fruit = cherry ? 0 : Math.max(0, g.fruit - 1), fruits = g.fruits;
  if (!fruit && eaten.size >= (FRUIT_AT[fruits] ?? Infinity)) { fruit = FRUIT_TICKS; fruits++; }
  const score = g.score + dot + (cherry ? POINTS.cherry : 0);
  const bonus = g.bonus || score >= EXTRA_LIFE_AT;
  const lives = g.lives + (bonus && !g.bonus ? 1 : 0);
  const t = g.t + 1;
  const power = dot === POINTS.power;
  const fright = power ? FRIGHT.ticks : Math.max(0, g.fright - 1);
  const clock = fright ? g.clock : g.clock + 1;
  // 4s without a dot frees the next ghost still waiting in the house.
  let idle = dot ? 0 : g.idle + 1, freed = g.freed;
  const waiting = GHOSTS.findIndex((_, i) => !released(g, i));
  if (idle >= RELEASE_IDLE && waiting >= 0) { idle = 0; freed = waiting + 1; }
  const next = { ...g, pos, dir, acc, eaten, fruit, fruits, score, bonus, lives, t, clock, fright, idle, freed, combo: power ? 0 : g.combo };
  if (cleared(next)) return next; // last dot: the ghosts don't get a move on it
  // A power pellet, like a mode switch, turns every ghost around.
  const flip = scatter(clock) !== scatter(g.clock) || power;
  // Blinky's Elroy boost: on once few enough dots remain, but off after a death until Clyde is back out.
  const left = DOT_KEYS.size - eaten.size;
  const elroy = g.ghosts[3]!.out ? SPEED.elroy.find(([dots]) => left <= dots)?.[1] : undefined;
  const ghosts = g.ghosts.map((gh, i) => {
    if (gh.mode === "eyes") {
      const acc = gh.acc + rate(SPEED.eyes);
      return acc < 1 ? { ...gh, acc } : goHome({ ...gh, acc: acc - 1 }, i);
    }
    const scared = power || (gh.mode === "scared" && fright > 0);
    gh = { ...gh, mode: scared ? "scared" : "normal" };
    if (!gh.out && !released(next, i)) return gh;
    if (flip) gh = { ...gh, dir: [-gh.dir[0], -gh.dir[1]] };
    const acc = gh.acc + rate(tunnel(gh.pos) ? SPEED.tunnel : scared ? SPEED.fright : (i === 0 && elroy) || SPEED.ghost);
    if (acc < 1) return { ...gh, acc };
    const target = !gh.out ? GHOSTS[i]!.door : scared ? null : scatter(clock) ? GHOSTS[i]!.corner : TARGET[i]!(next);
    return moveGhost({ ...gh, acc: acc - 1 }, target);
  });
  const after = { ...next, ghosts };
  const bit = ghosts.findIndex((gh, i) => gh.mode === "scared" && met(g, after, i));
  if (bit >= 0) {
    const points = POINTS.ghost << g.combo;
    const eyes = ghosts.map((gh, i) => (i === bit ? { ...gh, mode: "eyes" as const } : gh));
    return { ...after, ghosts: eyes, score: score + points, combo: g.combo + 1, bite: { pos, points, left: SEC } };
  }
  if (!ghosts.some((gh, i) => gh.out && gh.mode === "normal" && met(g, after, i))) return after;
  // Death: everyone back to their start tiles, mode clock and fright reset; dots and score stay.
  return { ...after, lives: lives - 1, since: eaten.size, pos: PACMAN_SPAWN, dir: [0, 0], acc: 0, ghosts: NEW_GAME.ghosts, t: 0, clock: 0, fright: 0, idle: 0, freed: 0 };
}
