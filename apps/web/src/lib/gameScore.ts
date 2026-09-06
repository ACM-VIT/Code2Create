import { accuracyScoreScale, gameDefinition, type GameKey } from "@code2create/domain";

const points = new Intl.NumberFormat("en-IN");

/**
 * A score, written the way its own board counts.
 *
 * Most games tally points, and a tally reads as a number. One scores how closely
 * a colour was matched, and that reads as a percentage — "9,412" on an accuracy
 * board would be the board lying about what it measures. The kind lives with the
 * game in the domain catalogue, so a new game says how it counts in the same
 * place it says what it is worth.
 */
export function formatGameScore(gameKey: GameKey, score: number): string {
  const game = gameDefinition(gameKey);
  if (game?.scoreKind === "accuracy") {
    return `${(score / accuracyScoreScale).toFixed(1)}%`;
  }
  return points.format(score);
}
