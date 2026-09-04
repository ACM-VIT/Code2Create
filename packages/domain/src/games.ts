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
};

export const gameCatalog = [
  {
    key: "pacman",
    title: "Pac-Man",
    // One level: 233 pellets and 6 power pellets (2,630), two cherries (200),
    // and every ghost eaten on every power pellet (6 x 1,600+800+400+200 =
    // 18,000) come to 20,830. 25,000 leaves room for a maze edit.
    maximumScore: 25_000,
  },
] as const satisfies readonly GameDefinition[];

const byKey = new Map<string, GameDefinition>(gameCatalog.map((game) => [game.key, game]));

/** The definition for `key`, or null when the key is not a published game. */
export function gameDefinition(key: string): GameDefinition | null {
  return byKey.get(key) ?? null;
}

/** How many rounds one person may record per minute, across every game. */
export const gameRoundsPerMinute = 30;
