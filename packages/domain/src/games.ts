export const gameKeys = ["pacman", "stack", "memory", "memory-grid"] as const;
export type GameKey = (typeof gameKeys)[number];

export type GameDefinition = {
  readonly key: GameKey;
  readonly title: string;
  readonly maximumScore: number;
  readonly maximumScorePerSecond: number;
};

export const gameCatalog = [
  {
    key: "pacman",
    title: "Pac-Man",
    // Exactly what the shipped maze can produce: 233 pellets and 6 power
    // pellets (2,630), two cherries (200), and every ghost eaten on every power
    // pellet (6 x 200+400+800+1,600 = 18,000). No headroom above it — a round
    // that scores more than the board holds did not come from playing, and
    // slack here is slack a forged score can sit in. Editing the maze means
    // editing this number.
    maximumScore: 20_830,
    // The richest seconds in the game are a power-pellet chain: four ghosts for
    // 3,000 in roughly four seconds, so a real run peaks near 750/s and holds
    // nowhere near it for long. A maximum round therefore cannot be claimed in
    // under ~33s, against the minutes it truly takes.
    maximumScorePerSecond: 750,
  },
  {
    key: "stack",
    title: "Logo Stack",
    // A round is three lives at 100 points a piece, and the stack resets with
    // each life. Fifty pieces on a life is already an exceptional tower, so
    // 150 of them across the round — 15,000 — is far past a real ceiling;
    // 50,000 leaves room for the endless climb to keep going.
    maximumScore: 50_000,
    // A piece has to fall and then hold still for `SETTLE_MS` before it locks,
    // so 100 points cannot arrive faster than about once a second. 300/s is
    // several times the real rate and still refuses an instant round.
    maximumScorePerSecond: 300,
  },
  {
    key: "memory",
    title: "Memory",
    // A finished board starts from a perfect 5,000 and spends from it: 40 a
    // move past the twelve a flawless memory needs, and 5 a second. Nothing
    // scores above the perfect board, so that is the ceiling exactly.
    maximumScore: 5_000,
    // Turning 24 cards takes time even played perfectly, and the score only
    // falls as the clock runs. 400/s puts the ceiling out of reach until about
    // 12 seconds in, which no real board is finished inside.
    maximumScorePerSecond: 400,
  },
  {
    key: "memory-grid",
    title: "Memory Grid",
    // The pattern mode scores the levels survived. The board stops growing at
    // 10x10 and the pattern keeps thickening, so nobody is finishing anywhere
    // near this; it is a bound, not a target.
    maximumScore: 200,
    // A level cannot be cleared faster than the pattern is shown plus the taps
    // to answer it — call it two seconds at the very best. 2/s is several times
    // that and still refuses a round that claims levels it had no time to play.
    maximumScorePerSecond: 2,
  },
] as const satisfies readonly GameDefinition[];

const byKey = new Map<string, GameDefinition>(gameCatalog.map((game) => [game.key, game]));

/** The definition for `key`, or null when the key is not a published game. */
export function gameDefinition(key: string): GameDefinition | null {
  return byKey.get(key) ?? null;
}

/**
 * How long a run token stays valid. A round has to be reported from the run it
 * was played in, and an abandoned run stops being usable rather than being
 * banked for a later claim.
 */
export const gameRunLifetimeMs = 60 * 60 * 1000;

/** How many rounds one person may record per minute, across every game. */
export const gameRoundsPerMinute = 30;
