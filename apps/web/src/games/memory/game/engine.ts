export type Motif = { readonly motif: string; readonly asset: string };

export const MOTIFS: readonly Motif[] = [
  { motif: "Shark", asset: "Shark.png" },
  { motif: "Jellyfish", asset: "Jellyfish.png" },
  { motif: "Fish", asset: "Fish.png" },
  { motif: "Cone shell", asset: "ConeShell.png" },
  { motif: "Snail", asset: "Snail.png" },
  { motif: "Conch", asset: "Conch.png" },
  { motif: "Sea turtle", asset: "Turtle.png" },
  { motif: "Seahorse", asset: "Seahorse.png" },
  { motif: "Seagrass", asset: "Seagrass.png" },
  { motif: "Manta ray", asset: "MantaRay.png" },
  { motif: "Whale", asset: "Whale.png" },
  { motif: "Coral", asset: "Coral.png" },
];

export const PAIR_COUNT = MOTIFS.length;
export const PERFECT_MOVES = PAIR_COUNT;

export type Card = {
  readonly id: string;
  readonly pairKey: string;
  readonly motif: string;
  readonly asset: string;
  readonly isFaceUp: boolean;
  readonly isMatched: boolean;
};

export type GameStatus = "ready" | "playing" | "complete";

export type MemoryGame = {
  readonly cards: readonly Card[];
  readonly moves: number;
  readonly selectedIds: readonly string[];
  readonly pendingMismatch: readonly string[];
  readonly status: GameStatus;
};

export type SelectionEvent =
  | { readonly type: "ignored" }
  | { readonly type: "first"; readonly cardId: string }
  | { readonly type: "mismatch"; readonly cardIds: readonly [string, string] }
  | { readonly type: "match"; readonly pairKey: string }
  | { readonly type: "complete"; readonly pairKey: string };

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const other = shuffled[swapIndex];
    if (current === undefined || other === undefined) continue;
    shuffled[index] = other;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

export function createDeck(random: () => number = Math.random): Card[] {
  const cards = MOTIFS.flatMap(({ motif, asset }) =>
    Array.from({ length: 2 }, (_, copy) => ({
      id: `${motif}-${copy}`,
      pairKey: motif,
      motif,
      asset,
      isFaceUp: false,
      isMatched: false,
    })),
  );
  return shuffle(cards, random);
}

export function createGame(random: () => number = Math.random): MemoryGame {
  return {
    cards: createDeck(random),
    moves: 0,
    selectedIds: [],
    pendingMismatch: [],
    status: "ready",
  };
}

function ignored(state: MemoryGame) {
  return { state, event: { type: "ignored" } as const };
}

/** How many pairs are face up for good. */
export function matchedPairs(state: MemoryGame): number {
  return state.cards.filter((card) => card.isMatched).length / 2;
}

export function selectCard(
  state: MemoryGame,
  cardId: string,
): { state: MemoryGame; event: SelectionEvent } {
  if (state.status === "complete" || state.pendingMismatch.length > 0) {
    return ignored(state);
  }

  const card = state.cards.find((item) => item.id === cardId);
  if (!card || card.isFaceUp || card.isMatched) {
    return ignored(state);
  }

  const cards = state.cards.map((item) =>
    item.id === cardId ? { ...item, isFaceUp: true } : item,
  );

  if (state.selectedIds.length === 0) {
    return {
      state: { ...state, cards, selectedIds: [cardId], status: "playing" },
      event: { type: "first", cardId },
    };
  }

  const firstId = state.selectedIds[0];
  const firstCard = firstId === undefined ? undefined : cards.find((item) => item.id === firstId);
  if (firstId === undefined || firstCard === undefined) return ignored(state);
  const moves = state.moves + 1;

  if (firstCard.pairKey !== card.pairKey) {
    return {
      state: {
        ...state,
        cards,
        moves,
        selectedIds: [firstId, cardId],
        pendingMismatch: [firstId, cardId],
      },
      event: { type: "mismatch", cardIds: [firstId, cardId] },
    };
  }

  const matched = cards.map((item) =>
    item.id === firstId || item.id === cardId ? { ...item, isMatched: true } : item,
  );
  const isComplete = matched.every((item) => item.isMatched);

  return {
    state: {
      ...state,
      cards: matched,
      moves,
      selectedIds: [],
      status: isComplete ? "complete" : "playing",
    },
    event: { type: isComplete ? "complete" : "match", pairKey: card.pairKey },
  };
}

export function concealMismatch(state: MemoryGame): MemoryGame {
  if (state.pendingMismatch.length === 0) return state;
  const pending = new Set(state.pendingMismatch);
  return {
    ...state,
    cards: state.cards.map((card) =>
      pending.has(card.id) && !card.isMatched ? { ...card, isFaceUp: false } : card,
    ),
    selectedIds: [],
    pendingMismatch: [],
  };
}
