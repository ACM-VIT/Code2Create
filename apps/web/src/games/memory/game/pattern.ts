/**
 * The pattern mode's rules, with no board and no timers.
 *
 * A level lights a handful of squares, hides them, and asks for them back in
 * any order. Three lives; a wrong square costs one and replays the level.
 * Ported from the standalone grid game so the logic can be tested on its own.
 */

export type PatternPhase = "showing" | "playing" | "levelCleared" | "failed";

export type PatternGame = {
  readonly level: number;
  /** Levels finished, which is what the round scores. */
  readonly cleared: number;
  readonly lives: number;
  readonly pattern: ReadonlySet<number>;
  readonly picked: ReadonlySet<number>;
  /** The square just got wrong, so the board can mark it before replaying. */
  readonly wrong: number | null;
  readonly phase: PatternPhase;
};

export const STARTING_LIVES = 3;
const smallestGrid = 3;
const largestGrid = 10;

/** The board grows a row and a column every four levels, up to 10x10. */
export function gridSize(level: number): number {
  return Math.min(largestGrid, smallestGrid + Math.floor((level - 1) / 4));
}

export function cellCount(level: number): number {
  return gridSize(level) ** 2;
}

/** How many squares light up. It thickens more slowly than the board grows. */
export function targetCount(level: number): number {
  return Math.min(cellCount(level), 3 + Math.floor((level - 1) ** 0.72));
}

/** How long the pattern is shown, shrinking as the levels climb. */
export function revealMs(level: number): number {
  return Math.max(900, 1800 - level * 35);
}

function choosePattern(level: number, random: () => number): Set<number> {
  const spaces = Array.from({ length: cellCount(level) }, (_, index) => index);
  for (let index = spaces.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = spaces[index];
    const other = spaces[swapIndex];
    if (current === undefined || other === undefined) continue;
    spaces[index] = other;
    spaces[swapIndex] = current;
  }
  return new Set(spaces.slice(0, Math.min(targetCount(level), spaces.length)));
}

/** A fresh round: level one, full lives, first pattern already drawn. */
export function createPatternGame(random: () => number = Math.random): PatternGame {
  return {
    level: 1,
    cleared: 0,
    lives: STARTING_LIVES,
    pattern: choosePattern(1, random),
    picked: new Set(),
    wrong: null,
    phase: "showing",
  };
}

/** The pattern has been shown for long enough; the player may answer. */
export function beginPlay(state: PatternGame): PatternGame {
  return state.phase === "showing" ? { ...state, phase: "playing", wrong: null } : state;
}

/**
 * A square chosen while playing.
 *
 * A right one is kept, and the last of them clears the level. A wrong one costs
 * a life and puts the board back into `showing`, so the same level is replayed
 * with the same pattern rather than a new one.
 */
export function chooseSquare(state: PatternGame, index: number): PatternGame {
  if (state.phase !== "playing" || state.picked.has(index)) return state;

  if (!state.pattern.has(index)) {
    const lives = state.lives - 1;
    return {
      ...state,
      lives,
      wrong: index,
      picked: new Set(),
      phase: lives <= 0 ? "failed" : "showing",
    };
  }

  const picked = new Set(state.picked).add(index);
  if (picked.size < state.pattern.size) return { ...state, picked, wrong: null };

  return {
    ...state,
    picked,
    wrong: null,
    cleared: state.level,
    phase: "levelCleared",
  };
}

/** Move on to the next level, once the cleared board has been seen. */
export function nextLevel(
  state: PatternGame,
  random: () => number = Math.random,
): PatternGame {
  if (state.phase !== "levelCleared") return state;
  const level = state.level + 1;
  return {
    ...state,
    level,
    pattern: choosePattern(level, random),
    picked: new Set(),
    wrong: null,
    phase: "showing",
  };
}

/** Replay the level a wrong square interrupted, with a life already spent. */
export function replayLevel(state: PatternGame): PatternGame {
  if (state.phase !== "showing" || state.wrong === null) return state;
  return { ...state, wrong: null, picked: new Set() };
}
