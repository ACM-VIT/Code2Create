/**
 * The bento's grid, as data. The mockup has seven slots; every breakpoint is
 * one named-area template over those slots, and opening a tile swaps in a
 * template where its slot takes the big spot. Which tile sits in which slot
 * is decided by relevance: `composeDashboard` ranks whatever tiles exist and
 * seats the top seven, most relevant in the most prominent slot.
 */
export const slots = ["hero", "feature", "rose", "blossom", "garden", "center", "small"] as const;

/** The slots, most prominent first: wide top, tall right, tall left, the top-right box, then the rest. */
export type Slot = (typeof slots)[number];

export const tileKeys = [
  "event",
  "music",
  "squad",
  "integrations",
  "updates",
  "review",
  "help",
  "benefits",
] as const;

export type TileKey = (typeof tileKeys)[number];

export type GridTemplate = {
  columns: string;
  rows: string;
  /** One string per row, e.g. `hero hero blossom`. */
  areas: readonly string[];
};

type Breakpoint = "base" | "md" | "lg";

const resting: Record<Breakpoint, GridTemplate> = {
  base: {
    columns: "repeat(2, minmax(0, 1fr))",
    rows: "minmax(150px, 1.15fr) minmax(210px, 1.45fr) repeat(3, minmax(145px, 1fr)) minmax(112px, .8fr)",
    areas: [
      "hero hero",
      "blossom blossom",
      "center center",
      "feature feature",
      "rose rose",
      "small garden",
    ],
  },
  md: {
    columns: "repeat(2, minmax(0, 1fr))",
    rows: "minmax(0, 1.35fr) repeat(4, minmax(0, 1fr))",
    areas: ["hero hero", "blossom rose", "center feature", "garden feature", "garden small"],
  },
  lg: {
    columns: "minmax(0, 322fr) minmax(0, 365fr) minmax(0, 395fr)",
    rows: "minmax(0, 293fr) minmax(0, 234fr) minmax(0, 70fr) minmax(0, 177fr)",
    areas: ["hero hero blossom", "rose center feature", "rose garden feature", "small garden feature"],
  },
};

/** `F` is the opened slot; the letters are the other slots, most prominent first. */
const focused: Record<Breakpoint, GridTemplate> = {
  base: {
    columns: "repeat(2, minmax(0, 1fr))",
    rows: "repeat(2, minmax(190px, 1.4fr)) repeat(3, minmax(108px, 1fr))",
    areas: ["F F", "F F", "a b", "c d", "e g"],
  },
  md: {
    columns: "repeat(2, minmax(0, 1fr))",
    rows: "repeat(2, minmax(200px, 1.5fr)) repeat(3, minmax(0, 1fr))",
    areas: ["F F", "F F", "a b", "c d", "e g"],
  },
  lg: {
    columns: "minmax(0, 322fr) minmax(0, 365fr) minmax(0, 395fr)",
    rows: "minmax(0, 250fr) minmax(0, 180fr) minmax(0, 170fr) minmax(0, 174fr)",
    areas: ["F F a", "F F b", "c c b", "d e g"],
  },
};

const letters = ["a", "b", "c", "d", "e", "g"] as const;

function fillTemplate(template: GridTemplate, focus: Slot): GridTemplate {
  const others = slots.filter((slot) => slot !== focus);
  const bySlot = new Map<string, Slot>([["F", focus]]);
  letters.forEach((letter, index) => {
    const slot = others[index];
    if (slot) bySlot.set(letter, slot);
  });
  return {
    ...template,
    areas: template.areas.map((row) =>
      row
        .split(" ")
        .map((cell) => bySlot.get(cell) ?? cell)
        .join(" "),
    ),
  };
}

export function gridTemplates(focus: Slot | null): Record<Breakpoint, GridTemplate> {
  if (focus === null) return resting;
  return {
    base: fillTemplate(focused.base, focus),
    md: fillTemplate(focused.md, focus),
    lg: fillTemplate(focused.lg, focus),
  };
}

/** The `grid-template-areas` value: each row quoted. */
export function areasValue(template: GridTemplate) {
  return template.areas.map((row) => `"${row}"`).join(" ");
}

/** Spelled out so Tailwind sees every class; keyed by slot. */
export const slotAreaClass: Record<Slot, string> = {
  hero: "[grid-area:hero]",
  feature: "[grid-area:feature]",
  rose: "[grid-area:rose]",
  garden: "[grid-area:garden]",
  center: "[grid-area:center]",
  blossom: "[grid-area:blossom]",
  small: "[grid-area:small]",
};

/** What a slot is good at: wide for a headline, tall for a list or a video, box for a summary. */
export type SlotShape = "wide" | "tall" | "box";

export const slotShape: Record<Slot, SlotShape> = {
  hero: "wide",
  feature: "tall",
  rose: "tall",
  garden: "box",
  center: "box",
  blossom: "box",
  small: "wide",
};

export type Candidate = {
  key: TileKey;
  score: number;
  /** Slot shapes the tile reads best in, best first; any shape as a last resort. */
  prefer: readonly SlotShape[];
};

/**
 * Seats the seven most relevant tiles. Higher scores choose first and take
 * the most prominent free slot of a shape they prefer; ties keep the order
 * given. Tiles left over are not shown at all.
 */
export function composeDashboard(candidates: readonly Candidate[]): Partial<Record<TileKey, Slot>> {
  const ranked = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, slots.length);
  const free = new Set<Slot>(slots);
  const seating: Partial<Record<TileKey, Slot>> = {};
  for (const candidate of ranked) {
    const shapes = [...candidate.prefer, "wide", "tall", "box"] as const;
    const slot = shapes
      .map((shape) => slots.find((option) => free.has(option) && slotShape[option] === shape))
      .find((option): option is Slot => option !== undefined);
    if (!slot) break;
    free.delete(slot);
    seating[candidate.key] = slot;
  }
  return seating;
}
