import { gameCatalog, type GameKey } from '@code2create/domain'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * The playable games, in the order the arcade lists them.
 *
 * The server-side half of a game — its title and the score bound it is held to
 * — lives in the domain catalogue, which the backend also reads. This file adds
 * only what the browser needs: the board itself and a line of copy. Adding a
 * game is an entry in each, and nothing else.
 *
 * Boards are lazy so the arcade's artwork and game loop stay out of the portal's
 * first load; nobody pays for Pac-Man on their way to writing an idea.
 */
/**
 * One way of playing a game.
 *
 * A mode is its own game as far as the server is concerned — it has its own key,
 * its own score bound and its own leaderboard — because two modes measure
 * different things and ranking one against the other would say nothing. The
 * arcade still presents them as a single game with a switch, which is how they
 * are played.
 */
export type GameMode = {
  readonly key: GameKey
  readonly label: string
}

export type GameBoardProps = {
  /**
   * Called the moment a round begins, before any of it is played. The arcade
   * opens a server-side run on it, which the round is then reported against.
   */
  onRoundStart: () => void
  /** Called once with the round's score the moment a round ends. */
  onRoundEnd: (score: number) => void
  /** The mode being played, for a board that has more than one. */
  mode?: GameKey
  /** Every way this game can be played, so the board can offer the switch. */
  modes?: readonly GameMode[]
  /** Asks the arcade to switch mode, which also moves the leaderboard. */
  onModeChange?: (mode: GameKey) => void
}

export type GameEntry = {
  readonly key: GameKey
  readonly title: string
  readonly blurb: string
  readonly Board: LazyExoticComponent<ComponentType<GameBoardProps>>
  /** Present when the game is played more than one way. */
  readonly modes?: readonly GameMode[]
}

const boards: Record<GameKey, LazyExoticComponent<ComponentType<GameBoardProps>>> = {
  pacman: lazy(() =>
    import('./pacman/Map.tsx').then((module) => ({ default: module.default })),
  ),
  stack: lazy(() =>
    import('./stack/Board.tsx').then((module) => ({ default: module.default })),
  ),
  memory: lazy(() =>
    import('./memory/Board.tsx').then((module) => ({ default: module.default })),
  ),
  // Reached through Memory's mode switch rather than as an entry of its own.
  'memory-grid': lazy(() =>
    import('./memory/Board.tsx').then((module) => ({ default: module.default })),
  ),
}

const blurbs: Record<GameKey, string> = {
  pacman: 'Clear the maze, dodge the ghosts, and eat them while the power pellet lasts.',
  stack: 'Drop each piece onto the tower and keep it standing. Three lives, one running total.',
  memory: 'Two ways to remember: find the pairs, or hold the pattern as it grows.',
  'memory-grid': 'Hold the pattern as it grows.',
}

const modes: Partial<Record<GameKey, readonly GameMode[]>> = {
  // Pattern leads: it is the quicker one to pick up, and the first mode is what
  // the game opens on and what its card reports a standing for.
  memory: [
    { key: 'memory-grid', label: 'Pattern' },
    { key: 'memory', label: 'Pairs' },
  ],
}

/** Modes appear under the game that owns them, never as a game of their own. */
const ownedByAnotherGame = new Set<GameKey>(
  Object.entries(modes).flatMap(([owner, list]) =>
    (list ?? []).map((mode) => mode.key).filter((key) => key !== owner),
  ),
)

export const games: readonly GameEntry[] = gameCatalog
  .filter((game) => !ownedByAnotherGame.has(game.key))
  .map((game) => ({
    key: game.key,
    title: game.title,
    blurb: blurbs[game.key],
    Board: boards[game.key],
    ...(modes[game.key] ? { modes: modes[game.key] } : {}),
  }))
