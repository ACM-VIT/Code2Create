import type { HsvColor } from "./color.ts";

/**
 * The colours a game asks for.
 *
 * The original picked its targets out of other companies' logos — Docker's
 * blue, Chrome's red, Acer's green. Those are their marks, not ours to ship, so
 * the targets are colours in their own right here and the mark they are shown
 * on is the event's.
 *
 * The first two rounds are always the event's own pinks: it is a blossom portal,
 * and a player should meet the colour they already know before the game starts
 * asking for ones they do not.
 */

export type ColorRound = {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly target: HsvColor;
};

export const roundsPerGame = 5;

const pinks: readonly { id: string; label: string; target: HsvColor }[] = [
  { id: "rose", label: "soft rose", target: { hue: 335, saturation: 65, value: 85 } },
  { id: "magenta", label: "vivid magenta", target: { hue: 345, saturation: 78, value: 90 } },
  { id: "berry", label: "deep berry", target: { hue: 325, saturation: 60, value: 80 } },
  { id: "blossom", label: "cherry blossom", target: { hue: 350, saturation: 72, value: 88 } },
  { id: "petal", label: "petal pink", target: { hue: 330, saturation: 65, value: 80 } },
];

const others: readonly { id: string; label: string; target: HsvColor }[] = [
  { id: "sky", label: "clear sky", target: { hue: 200, saturation: 95, value: 88 } },
  { id: "iris", label: "iris", target: { hue: 264, saturation: 86, value: 90 } },
  { id: "lagoon", label: "lagoon", target: { hue: 186, saturation: 82, value: 86 } },
  { id: "ember", label: "ember", target: { hue: 14, saturation: 60, value: 85 } },
  { id: "moss", label: "moss", target: { hue: 78, saturation: 92, value: 73 } },
  { id: "amber", label: "amber", target: { hue: 38, saturation: 88, value: 92 } },
  { id: "cinnabar", label: "cinnabar", target: { hue: 4, saturation: 80, value: 90 } },
];

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = list[index];
    const other = list[swap];
    if (current === undefined || other === undefined) continue;
    list[index] = other;
    list[swap] = current;
  }
  return list;
}

/** Five rounds: two of the event's pinks, then three of everything else. */
export function chooseRounds(random: () => number = Math.random): ColorRound[] {
  const pink = shuffled(pinks, random).slice(0, 2);
  const rest = shuffled(others, random).slice(0, roundsPerGame - 2);
  return [...pink, ...rest].map((round, index) => ({
    id: `${index + 1}-${round.id}`,
    label: round.label,
    hint: `Hold the ${round.label} in mind, then mix it back.`,
    target: round.target,
  }));
}
