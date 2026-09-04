/**
 * The arcade games the portal offers and the bounds the server enforces on the
 * rounds they report.
 *
 * Adding a game is one entry here plus its screen in the web catalogue: the
 * backend reads nothing game-specific, so a new key needs no schema or query
 * change. Scores are per person and per round, never per team, and a person may
 * replay a game as often as they like — the leaderboard keeps their best round.
 */

export const gameKeys = ["pacman"] as const;
export type GameKey = (typeof gameKeys)[number];

export type GameDefinition = {
  readonly key: GameKey;
  readonly title: string;
  /**
   * The highest score the game can produce, with headroom. The browser reports
   * its own score, so this is the cheap bound that keeps a tampered round off
   * the board; it is not a claim that the score is verified.
   */
  readonly maximumScore: number;
  /**
   * The most points a round can plausibly earn per second of play, with
   * headroom. The server holds a reported score against the wall-clock time the
   * run was actually open, so a round cannot claim more than a real player
   * could have scored in that long.
   */
  readonly maximumScorePerSecond: number;
};

export const gameCatalog = [
  {
    key: "pacman",
    title: "Pac-Man",
    // One level: 233 pellets and 6 power pellets (2,630), two cherries (200),
    // and every ghost eaten on every power pellet (6 x 1,600+800+400+200 =
    // 18,000) come to 20,830. 25,000 leaves room for a maze edit.
    maximumScore: 25_000,
    // The richest seconds in the game are a power-pellet chain: four ghosts for
    // 3,000 in roughly four seconds, so a real run peaks near 750/s and holds
    // nowhere near it for long. A maximum round therefore cannot be claimed in
    // under ~33s, against the minutes it truly takes.
    maximumScorePerSecond: 750,
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
