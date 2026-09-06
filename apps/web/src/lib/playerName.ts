/**
 * The names on a leaderboard.
 *
 * Two things are wrong with a sign-in name shown as it arrives. Some providers
 * hand them over in capitals, which shouts down a quiet board; and some are
 * longer than the column they sit in, which leaves the browser to cut them
 * mid-word — "Venkata Naga Sai Krish…" says less than a shortened name would.
 */

/** Names longer than this are shortened. Measured against the board's column. */
export const maximumPlayerNameLength = 22;

/**
 * A name in its ordinary case.
 *
 * Providers hand some over in capitals ("ATHARVA LALWANI"); those are set as
 * names, and a mixed-case one is left exactly as its owner wrote it. A roll
 * number inside the name keeps its capitals, since that is how it is written.
 */
export function personLabel(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (match) => match.toUpperCase())
    .replace(/\b(\d{2}[a-z]{3}\d{4})\b/gi, (roll) => roll.toUpperCase());
}

/**
 * A name that fits the board.
 *
 * A long name becomes its first name and a last initial — "Venkata P." — which
 * still identifies its owner among a handful of players, where a cut-off string
 * mostly identifies where the column ended. Anything still too long is left to
 * the column's own ellipsis, and the full name stays on the element's title.
 */
export function shortPlayerName(name: string): string {
  const label = personLabel(name).trim().replace(/\s+/gu, " ");
  if (label.length <= maximumPlayerNameLength) return label;

  const parts = label.split(" ").filter(Boolean);
  const first = parts[0];
  if (first === undefined) return label;
  if (parts.length === 1) return first;

  const surname = parts[parts.length - 1];
  const initial = surname === undefined ? "" : [...surname][0];
  return initial === undefined || initial === "" ? first : `${first} ${initial}.`;
}
